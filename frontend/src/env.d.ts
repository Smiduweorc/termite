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
