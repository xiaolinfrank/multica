import { streamInputUpload, type InputUploadRouteParams } from "@/lib/input-upload-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: Promise<InputUploadRouteParams> }) {
  return streamInputUpload(request, await context.params);
}
