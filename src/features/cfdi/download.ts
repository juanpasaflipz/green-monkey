/** Download links (spec §5.1): the authenticated file route and the portal's token route. */
import type { CfdiDocumentFile } from "../../../shared/cfdi";

export function fileUrl(documentId: string, format: CfdiDocumentFile): string {
  return `/api/cfdi/documents/${encodeURIComponent(documentId)}/file/${format}`;
}
export function portalFileUrl(token: string, format: "pdf" | "xml"): string {
  return `/api/cfdi/portal/files/${encodeURIComponent(token)}/${format}`;
}
