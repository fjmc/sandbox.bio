import { get, readable, writable } from "svelte/store";
import { createClient } from "@supabase/supabase-js";

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const hostname = window.location.hostname == "localhost" ? "dev.sandbox.bio" : window.location.hostname;
const urlAPI = `https://${hostname}/api/v1`;
const urlSupabase = {
	"dev.sandbox.bio": {
		url: "https://bqjvxpdzkembvixymfae.supabase.co",
		publicKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlhdCI6MTYyOTMyODIwNCwiZXhwIjoxOTQ0OTA0MjA0fQ.7DzKM4bOGK1t-pPkfSe-2ALxcW5xWwcsaZfbCMWDBbY"
	},
	"stg.sandbox.bio": {
		url: "",
		publicKey: ""
	},
	"prd.sandbox.bio": {
		url: "",
		publicKey: ""
	}
};

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

// User-defined variables
export const env = writable({});

// Supabase client
export const supabase = readable(createClient(urlSupabase[hostname].url, urlSupabase[hostname].publicKey));
export const user = writable(get(supabase).auth.user());

// App settings (read-only)
export const config = readable({
	// API
	api: urlAPI,
	// Default environment information
	hostname: "sandbox",
	// Default environment variables. These are auto-regenerated in Terminal.svelte:input() even if the user deletes them
	env: {
		PS1: '\\u@\\h$ ',
		USER: "guest",
		HOME: "/shared/data"
	},
	playground: `\u001b[0;37m# This playground is for open-ended exploration.
# For guided tutorials, see https://sandbox.bio/tutorials
#
# Example:
#   samtools view -o test.bam /samtools/examples/toy.sam
#   samtools index test.bam
#   ls test.bam.bai
#   samtools idxstats test.bam  # idxstats uses the .bai file \u001b[0m
`
});
