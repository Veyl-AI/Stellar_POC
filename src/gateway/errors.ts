/** Thrown for any client-caused input problem — always safe to surface its `message` to the caller. */
export class BadRequestError extends Error {}
