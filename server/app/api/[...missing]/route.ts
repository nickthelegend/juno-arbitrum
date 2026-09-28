import { junoError, junoOptions } from "@/lib/juno/api";

export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/** Unknown API paths answer in JSON, like every other route, rather than with an HTML page. */
const notFound = () => junoError("No such API route", 404);
export const GET = notFound;
export const POST = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
