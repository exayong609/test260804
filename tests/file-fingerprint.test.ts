import assert from "node:assert/strict";
import test from "node:test";
import { sha256Blob } from "../src/lib/file-fingerprint";
import { fileHash } from "../src/lib/import-upload";

test("browser and server calculate the same file fingerprint", async () => {
  const bytes = new TextEncoder().encode("two-phase-upload-contract");
  assert.equal(await sha256Blob(new Blob([bytes])), fileHash(bytes));
});
