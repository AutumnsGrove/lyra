// A single-page app behind a static Worker: there is no server rendering, and nothing is
// prerendered, because every route is the same page with a token box and a transcript
// (issue #60, slice 2).
export const ssr = false;
export const prerender = false;
