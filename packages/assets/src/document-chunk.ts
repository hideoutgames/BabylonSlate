/** Editor documents keep their JSON body in one chunk so headers stay cheap to scan. A leaf, so the diff worker reads it without the document writers. */
export const DOCUMENT_CHUNK_ID = "document";
