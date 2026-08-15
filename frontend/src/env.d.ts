/// <reference types="vite/client" />

/** The logo, imported as a URL by Vite. `vite/client` covers this, declared for clarity. */
declare module "*.svg" {
	const src: string;
	export default src;
}

interface ImportMetaEnv {
	readonly VITE_API_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}

/**
 * Written into index.html at container start by frontend/docker-entrypoint.sh, which is
 * how a prebuilt image learns its backend's address. Every field is optional: under
 * `vite dev` nothing rewrites the placeholder, and outside Docker nothing sets it at all.
 */
interface Window {
	__TERMITE__?: { apiUrl?: string };
}
