// Kiosk (039): payments' kiosk_hold settler (the payments_settle job and every sync path settle
// through it) and the menu media jobs (media_purge, media_stale; critic R36: on the web).
import { registerKioskSettler } from "../../kiosk-accept.js";
import { registerMediaJobs } from "../../media.js";

registerKioskSettler();
registerMediaJobs();
