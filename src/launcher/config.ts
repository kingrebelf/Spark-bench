// Launcher, updates, feedback and support: every external address lives here.

export const REPO_OWNER = "kingrebelf";
export const REPO_NAME = "Spark-bench";
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const RELEASES_API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=30`;
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new`;

/** Stripe Payment Link; the customer picks the amount. */
export const DONATE_URL = "https://buy.stripe.com/4gMaEZbjc0cd23293U9IQ00";

/**
 * Feedback relay (see relay/README.md). Empty until a deployment is approved: reports then open a prefilled
 * GitHub issue in the browser instead. The SPARKBENCH_FEEDBACK_RELAY environment variable overrides it (testing).
 */
export const FEEDBACK_RELAY_URL = "";

/** How often a running app checks for updates (it also checks a few seconds after launch). */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** How often queued feedback is retried while the app runs. */
export const FEEDBACK_RETRY_INTERVAL_MS = 10 * 60 * 1000;
