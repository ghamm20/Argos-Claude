// lib/tools/doc-generate.ts — T5 Document Generation (approval, reversible)
//
// Writes {title, content, format: md|txt|json} to ARGOS_ROOT/output/.

import path from "node:path";
import { toolOk, toolErr, type ToolExecute } from "./types";
import { writeOutputFile } from "./util";

export const ID = "doc_generate";

export const execute: ToolExecute = async (params) => {
  const title = String(params.title ?? "document").trim() || "document";
  const rawContent = params.content;
  const fmt = String(params.format ?? "md").toLowerCase();
  const ext = ["md", "txt", "json"].includes(fmt) ? fmt : "md";

  let content =
    typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "", null, 2);
  if (!content.trim()) return toolErr(ID, "content is required");

  if (ext === "json") {
    try {
      const obj = typeof rawContent === "string" ? JSON.parse(content) : rawContent;
      content = JSON.stringify(obj, null, 2);
    } catch {
      /* not valid JSON — write the raw string */
    }
  } else if (ext === "md" && !content.trimStart().startsWith("#")) {
    content = `# ${title}\n\n${content}\n`;
  }

  try {
    const filePath = await writeOutputFile(title, ext, content);
    return toolOk(ID, `wrote ${path.basename(filePath)} (${Buffer.byteLength(content)} bytes)`, {
      data: { path: filePath, format: ext, bytes: Buffer.byteLength(content) },
    });
  } catch (e) {
    return toolErr(ID, `write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};
