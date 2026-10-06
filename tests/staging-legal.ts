/**
 * Signup fields for the staging qualification runners (account 031): the
 * restaurant is created with the documents the deployment currently serves
 * accepted, as the signup form does. A staging deployment without the legal
 * set needs LEGAL_UNPUBLISHED_SIGNUP=allow (never honored in production).
 */
export async function signupLegal(
  get: (path: string) => Promise<{
    legal: {
      status: string;
      signupOpen: boolean;
      documents: Record<"terms" | "privacy" | "dpa", { version: string }>;
    };
  }>,
) {
  const { legal } = await get("/api/account-config");
  if (!legal.signupOpen)
    throw Error(
      "signup is paused on this deployment: publish the legal set or set LEGAL_UNPUBLISHED_SIGNUP=allow (staging only)",
    );
  return {
    locale: "es" as const,
    legalAccepted: {
      terms: legal.documents.terms.version,
      privacy: legal.documents.privacy.version,
      dpa: legal.documents.dpa.version,
    },
  };
}
