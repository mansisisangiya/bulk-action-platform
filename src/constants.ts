/**
 * If the requested start time is within this many ms from "now", we run immediately
 * instead of using a delayed queue job (avoids flaky sub-second delays).
 */
export const SCHEDULE_THRESHOLD_MS = 1500; 
