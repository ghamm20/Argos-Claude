import { promises as fsp } from "node:fs";
import path from "node:path";

const SUPPORTED_EXTS = new Set([".md", ".markdown", ".txt", ".pdf", ".docx"]);

export class UnsupportedFileType extends Error {
  constructor(ext: string) {
    super(
      `file extension "${ext}" is not supported in v1. Supported: ${[...SUPPORTED_EXTS].join(", ")}`
    );
    this.name = "UnsupportedFileType";
  }
}

export async function extractText(filepath: string): Promise<string> {
  const ext = path.extname(filepath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    throw new UnsupportedFileType(ext || "<none>");
  }

  if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
    return fsp.readFile(filepath, "utf8");
  }

  if (ext === ".pdf") {
    const { PDFParse } = await import("pdf-parse");
    const buf = await fsp.readFile(filepath);
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const result = await parser.getText();
      return result.text || "";
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  if (ext === ".docx") {
    const mod = await import("mammoth");
    const mammoth = (mod.default ?? mod) as {
      extractRawText: (opts: { path: string }) => Promise<{ value: string }>;
    };
    const result = await mammoth.extractRawText({ path: filepath });
    return result.value || "";
  }

  throw new UnsupportedFileType(ext);
}
