import { customAlphabet } from "nanoid";

// Unambiguous alphabet (no 0/O/1/I/l) — these tokens end up in short links
// people read/type/click, so avoid characters that are easy to misread.
export const generateRefToken = customAlphabet("23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ", 8);
export const MAX_REF_TOKEN_ATTEMPTS = 5;
