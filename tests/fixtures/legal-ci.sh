# shellcheck shell=bash
# The fictional-but-plausible legal and support values CI publishes (account
# §2.2, LD-3), for a local compiled server under the browser suites:
#
#   . tests/fixtures/legal-ci.sh && NODE_ENV=production node build/server/index.js
#
# Same literals as tests/fixtures/legal-ci.ts and the browser and account-http
# steps of .github/workflows/qualification.yml (tests/legal-fixtures.test.ts
# keeps them equal), plus the job-level LEGAL_UNPUBLISHED_SIGNUP=allow.
# FICTIONAL test values: never copy them to Railway or any deployed environment.
# A value already set in the environment is kept.
export LEGAL_ENTITY_NAME="${LEGAL_ENTITY_NAME:-Nopal Verde Software S.A. de C.V.}"
export LEGAL_ENTITY_ADDRESS="${LEGAL_ENTITY_ADDRESS:-Calle Jacaranda 120, Col. Centro, 06000 Ciudad de México, CDMX}"
export LEGAL_PRIVACY_CONTACT_EMAIL="${LEGAL_PRIVACY_CONTACT_EMAIL:-privacidad@nopalverde.mx}"
export LEGAL_JURISDICTION="${LEGAL_JURISDICTION:-Ciudad de México}"
export SUPPORT_EMAIL="${SUPPORT_EMAIL:-soporte@nopalverde.mx}"
export SUPPORT_PHONE="${SUPPORT_PHONE:-+525512345678}"
export SUPPORT_HOURS="${SUPPORT_HOURS:-Lun–Sáb 9:00–21:00 (hora del centro)}"
export LEGAL_UNPUBLISHED_SIGNUP="${LEGAL_UNPUBLISHED_SIGNUP:-allow}"
