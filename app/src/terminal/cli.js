// Defines main logic for parsing and executing commands, using both coreutils
// for the small utilities and Aioli for the bioinformatics tools.
//
// Known Limitations:
// * Doesn't support subshells, globbing
// * Ctrl + C doesn't stop running process (e.g. `sleep 2 & sleep 5` + ^C does nothing)
// * Tail doesn't support `tail -n +3` format (but `head -n-2` and `head/tail -2` supported)

// Imports
import { readable } from "svelte/store";
import parse from "shell-parse";         // Transforms a bash command into an AST
import columnify from "columnify";       // Prettify columnar output
import prettyBytes from "pretty-bytes";  // Prettify number of bytes
import minimist from "minimist";         // Parse CLI arguments
import Aioli from "@biowasm/aioli";

// State
let _aioli = {};   // Aioli object
let _fs = {};      // Aioli filesystem object
let _jobs = 0;     // Number of jobs running in background
let _pid = 10000;  // Current pid
let _vars = {};    // User-defined variables!


// =============================================================================
// Initialize
// =============================================================================

// Initialize Aioli / prepare bioinformatics tools
// Format: { tools: [], files: [] }
async function init(config={})
{
	// Initialize
	_aioli = await new Aioli(config.tools, {
		env: window.location.hostname == "localhost" ? "stg" : "prd",
		debug: window.location.hostname == "localhost",
		printInterleaved: false
	});
	_fs = _aioli.tools[1].module.FS;

	// Pre-load files onto the main folder
	if(config.files?.length > 0) {
		// Mount URLs
		const urls = config.files.map(f => `${window.location.origin}/${f}`);
		const paths = await _aioli.mount(urls)

		// Rename Aioli-mounted URLs that are automatically given long names
		for(let i in urls) {
			const url = urls[i];
			const path = paths[i];

			const urlPrefix = url.split("/").slice(0, -1).join("/") + "/";
			const pathPrefix = urlPrefix.split("//").pop().replace(/\//g, "-");  // from Aioli code
			await exec(`mv ${path} ${path.replace(pathPrefix, "")}`);
		}
	}
}


// =============================================================================
// Custom transformations to apply to CLI commands (for now just aliases)
// =============================================================================

function transform(cmd)
{
	const tool = cmd.command.value;

	// Handle aliases (just bowtie for now)
	if(tool == "bowtie2")
		cmd.command.value = "bowtie2-align-s";

	return cmd;
}


// =============================================================================
// Execute a command
// =============================================================================

// Run a command
async function exec(cmd, callback=console.warn)
{
	// console.log("[exec]", cmd);

	// -------------------------------------------------------------------------
	// Input validation
	// -------------------------------------------------------------------------
	if(cmd.type == "subshell")
		throw "Error: subshells are not supported.";
	if(cmd.body)
		throw `Error: ${cmd.type} is not supported.`;
	if(cmd.args && cmd.args.find(a => a.type == "glob"))
		throw "Error: globbing (e.g. `ls *.txt`) is not supported.";

	// If string, convert it to an AST
	if(typeof cmd === "string") {
		try {
			return await exec(parse(cmd), callback);
		} catch (error) {
			if(error.name == "SyntaxError")
				throw "Unrecognized command";
			throw error;
		}
	}

	// -------------------------------------------------------------------------
	// Parse commands in AST sequentially
	// -------------------------------------------------------------------------
	if(Array.isArray(cmd))
	{
		let output = "";
		for(let command of cmd)
		{
			// If it's meant to be asynchronous, don't await around; call callback on its own time
			if(command.control == "&")
			{
				const summary = `[${_jobs++}] ${_pid++} `;
				exec(command, callback).then(out => {
					callback(out);
					callback("\n" + summary + "done\n");
					_jobs--;
				});
				callback(summary + "launched\n");
				continue;
			}

			// Otherwise, run the steps one after the other
			// Note: `&&` and `||` are  handled below
			output += "\n" + await exec(command, callback);
			output = output.trim();
		}
		return output;
	}

	// -------------------------------------------------------------------------
	// Special commands
	// -------------------------------------------------------------------------
	// Estimate command runtime
	if(cmd.type == "time") {
		const timeStart = window.performance.now();
		const output = await exec(cmd.command, callback);
		const timeEnd = window.performance.now();
		callback(`Runtime: ${Math.round((timeEnd - timeStart) * 100)/100}ms\n`);
		return output;
	}

	// Assign a value to a variable
	if(cmd.type == "variableAssignment") {
		const name = cmd.name;
		const value = await utils.getValue(cmd.value);
		_vars[name] = value;
		return "";
	}

	// -------------------------------------------------------------------------
	// Process a single command within the AST
	// -------------------------------------------------------------------------
	if(cmd.type == "command")
	{
		// console.log("[command]", cmd);

		// Interpret the command
		if(cmd.command == "[[")
			throw "Error: Test expressions not supported";
		try {
			let output;

			// Handle custom transforms on the command
			cmd = transform(cmd);

			// Parse args
			const tool = cmd.command.value;
			const argsRaw = await Promise.all(cmd.args.map(utils.getValue));
			const args = minimist(argsRaw, minimistConfig[tool]);

			// If it's a coreutils
			if(tool in coreutils)
				output = await coreutils[tool](args);
			// Otherwise, try running the command with Aioli
			else {
				const outputAioli = await _aioli.exec(`${tool} ${argsRaw.join(" ")}`.trim());
				// Output the stderr now
				callback(outputAioli.stderr);
				// Either output the stdout or pass it along with the pipe
				output = outputAioli.stdout;
			}

			// -----------------------------------------------------------------
			// Handle redirects, e.g. `... | head`, `... > test.txt`
			// -----------------------------------------------------------------
			for(let redirect of (cmd.redirects || []))
			{
				// Handle pipes
				if(redirect.type == "pipe") {
					// Save `output` to a temp file
					const pathTmpFile = await coreutils.mktemp();
					await _fs.writeFile(pathTmpFile, output);
					// Run commands with appending arg called temp file, unless
					// user specified we should use stdin via the argument "-".
					const argStdinIndex = redirect.command.args.findIndex(arg => arg.value == "-");
					if(argStdinIndex != -1)
						redirect.command.args[argStdinIndex].value = pathTmpFile
					else
						redirect.command.args.push({ type: "literal", value: pathTmpFile });
					return exec(redirect.command, callback);

				// Handle redirection to a file
				} else if(redirect.type == "redirectFd") {
					const path = await utils.getValue(redirect.filename);
					// Write to file
					if(redirect.op == ">")
						await _fs.writeFile(path, "" + output);  // convert to string if it's not already
					// Append to file (create it first if doesn't exist)
					else if(redirect.op == ">>") {
						try {
							await _fs.stat(path);
						} catch (error) {
							await _fs.writeFile(path, "");
						}
						let contents = await utils.readFiles([ path ]);
						await _fs.writeFile(path, (contents + "\n" + output).trim());
					} else {
						throw `Error: ${redirect.op} redirections are not supported.`;
					}
					return "";

				// Otherwise, don't know what to do
				} else {
					throw `Error: ${redirect.type} redirections are not supported.`;
				}
			}

			// -----------------------------------------------------------------
			// Handle next command, e.g. `echo 123 && echo 456`, `echo 123 ; echo 456`
			// -----------------------------------------------------------------
			if(cmd.next) {
				output += "\n" + await exec(cmd.next, callback);
				output = output.trim();
			}

			// If no redirections, just return the result
			return output;

		// If something fails, behave differently depending on e.g. `&&` vs `||`
		} catch (error) {
			// If using `||`, output error but keep going
			if(cmd.control == "||" && cmd.next) {
				callback(error);
				return await exec(cmd.next, callback);
			}
			// Reaches this line if e.g. using `&&`
			throw error;
		}
	}

	console.error("Unrecognized command:", cmd);
	throw "Unrecognized command";
}


// =============================================================================
// GNU Coreutils JavaScript implementation (only list functions here that should
// be directly callable by the user from the CLI).
// =============================================================================

const coreutils = {
	// sleep [1]
	sleep: args => {
		const duration = parseInt(args._[0]) || 1;
		return new Promise((resolve, reject) => {
			setTimeout(() => resolve(""), duration * 1000);
		});
	},

	// env
	env: args => Object.keys(_vars).map(v => `${v}=${_vars[v]}`).join("\n"),

	// -------------------------------------------------------------------------
	// File system management
	// -------------------------------------------------------------------------
	cd: args => _fs.chdir(args._[0]) && "",
	mv: args => _fs.rename(args._[0], args._[1]) && "",
	rm: args => Promise.all(args._.map(async arg => await _fs.unlink(arg))),
	pwd: args => _fs.cwd(),
	echo: args => args._.join(" "),
	mkdir: async args => {
		// Don't use async since can't get return value
		args._.map(arg => { try { _fs.mkdir(arg); } catch (error) {} });
		return "";
	},
	rmdir: args => Promise.all(args._.map(async arg => await _fs.rmdir(arg))),
	mktemp: args => {
		const path = `/shared/tmp/tmp${parseInt(Math.random() * 1_000_000)}`;
		_fs.writeFile(path, "");
		return path;
	},
	date: args => new Date().toLocaleString(),

	// -------------------------------------------------------------------------
	// File contents utilities
	// -------------------------------------------------------------------------
	// cat file1 [file2 ... fileN]
	cat: args => utils.readFiles(args._),

	// tail [-n 10|-10]
	tail: args => coreutils.head(args, true),

	// head [-n 10|-10]
	head: (args, tail=false) => {
		// Support older `head -5 myfile` format ==> args={ 5: myfile, _: [] }
		const nOld = Object.keys(args).find(arg => parseInt(arg));
		if(nOld)
			args = { n: nOld, _: [ args[nOld] ] };

		// Get first n lines
		const n = args.n || 10;
		return utils.readFiles(args._, tail ? [-n] : [0, n]);
	},

	// wc [-l|-w|-c] <file>
	wc: async args => {
		// Count number of lines/words/chars
		const output = await utils.readFiles(args._);
		let nbLines = output.trim().split("\n").length;
		let nbWords = output.trim().split(/\s+/).length;
		let nbChars = output.length;
		if(output == "")
			nbLines = nbWords = nbChars = 0;

		// Return result
		if(args.l) return nbLines;
		else if(args.w) return nbWords;
		else if(args.c) return nbChars;
		else return `${nbLines}\t${nbWords}\t${nbChars}`;
	},

	// grep [-v] [-i] [-e] [-E] <pattern> <file>
	grep: async args => {
		const pattern = new RegExp(args._[0], `g${args.i ? "i" : ""}`);
		const output = await utils.readFiles(args._.slice(1));
		return output.split("\n").filter(line => {
			if(args.v)
				return !line.match(pattern);
			return line.match(pattern);
		}).join("\n");
	},

	// -------------------------------------------------------------------------
	// ls [-l] <file1> <file2>
	// -------------------------------------------------------------------------
	ll: (args, raw) => coreutils.ls(args, raw),
	ls: async (args, raw=false) => {
		// Input validation and dedupping
		let paths = args._ || args;
		if(paths.length == 0)
			paths = ["."];
		paths = [...new Set(paths)];

		// Gather stats about files and folders
		let stats = [];
		for(let path of paths)
		{
			try {		
				let stat = await _fs.stat(path);
				// If the path is a file, we already have the info we need
				if(!await _fs.isDir(stat.mode))
					stats.push({
						name: path.split("/").pop(),
						size: stat.size,
						date: stat.mtime
					});

				// But if the path is a folder, get stat for each node in the folder
				else
				{
					const files = await _fs.readdir(path);
					for(let f of files)
					{
						if(f == "." || f == "..")
							continue;
						stat = await _fs.stat(`${path}/${f}`);
						const isDir = await _fs.isDir(stat.mode);
						let name = isDir ? f + "/" : f;
						name = (!raw && isDir) ? `\x1b[1;34m${name}\x1b[0m` : name;
						stats.push({
							name: name,
							size: stat.size,
							date: stat.mtime
						});
					}
				}
			} catch (error) {
				throw `${path}: No such file or directory`;
			}
		}

		// If don't want to ouput to screen
		if(raw)
			return stats;

		// Columnify output
		return columnify(stats.map(f => ({
			...f,
			size: prettyBytes(f.size),
			date: f.date.toLocaleString()
		})), {
			showHeaders: false,
			columnSplitter: "\t",
			columns: ["size", "date", "name"]
		});
	}
};


// =============================================================================
// Utility functions
// =============================================================================

const utils = {
	// Get the value of an argument (recursive if need-be)
	getValue: async arg => {
		if(arg.type == "literal")
			return arg.value;
		else if(arg.type == "variable")
			return _vars[arg.name] || "";
		// e.g. echo "something $abc $def"
		else if(arg.type == "concatenation")
			return (await Promise.all(arg.pieces.map(utils.getValue))).join("");
		// e.g. someprgm $(grep "bla" test.txt | wc -l)
		else if(arg.type == "commandSubstitution")
			return await exec(arg.commands);
		// e.g. bedtools -a <(grep "Enhancer" data.bed)
		else if(arg.type == "processSubstitution" && arg.readWrite == "<") {
			const output = await exec(arg.commands);
			const pathTmpFile = await coreutils.mktemp();
			await _fs.writeFile(pathTmpFile, output);
			return pathTmpFile;
		}
		else
			throw `Error: ${arg.type} arguments not supported.`;
	},

	// Read entire file contents from virtual file system, and can subset by line numbers
	// e.g. lineRange=`[0]`, `[0,1]`, `[0,5]`
	readFiles: async (paths, lineRange) => {
		if(!Array.isArray(paths))
			paths = [ paths ];

		// For each path, read entire file contents
		const outputs = await Promise.all(paths.map(async path => {
			let output = (await _fs.readFile(path, { "encoding": "utf8" })).trim();
			// Then subset by lines of interest (not efficient at all, but `FS.read()` fails due to WebWorker issues)
			if(Array.isArray(lineRange))
				output = output.split("\n").slice(...lineRange).join("\n");
			return output;
		}));

		// Add break line between different files
		return outputs.join("\n");
	},

	// Write file (used by Exercise.svelte)
	writeFile: (path, contents) => _fs.writeFile(path, contents)
};

// Custom minimist configs for certain coreutils
const minimistConfig = {
	wc: { boolean: ["l", "c", "w"] },
	grep: { boolean: ["v", "i", "e", "E"] },
	ls: { boolean: ["l", "a", "t", "r", "s", "h"] },
	echo: { boolean: ["e", "n"] }
};


// =============================================================================
// Export CLI as a readable store
// =============================================================================

export const CLI = readable({
	init,
	exec,
	coreutils,
	_vars
});