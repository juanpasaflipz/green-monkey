import { describe, expect, it } from "vitest";
import { libpqUrl } from "../scripts/ops/libpq-url.js";

describe("libpqUrl (restore drill's libpq tools)", () => {
  it("adds sslrootcert=system to a verify-full URL", () => {
    const out = new URL(
      libpqUrl(
        "postgresql://gm_migrator:pw@ep-x.us-east-2.aws.neon.tech/neondb?sslmode=verify-full",
      ),
    );
    expect(out.searchParams.get("sslrootcert")).toBe("system");
    expect(out.searchParams.get("sslmode")).toBe("verify-full");
    expect(out.password).toBe("pw");
  });
  it("adds it for verify-ca too", () => {
    expect(
      new URL(
        libpqUrl("postgresql://u@h/db?sslmode=verify-ca"),
      ).searchParams.get("sslrootcert"),
    ).toBe("system");
  });
  it("keeps an explicit sslrootcert", () => {
    expect(
      new URL(
        libpqUrl(
          "postgresql://u@h/db?sslmode=verify-full&sslrootcert=/etc/ca.pem",
        ),
      ).searchParams.get("sslrootcert"),
    ).toBe("/etc/ca.pem");
  });
  it("leaves non-verifying modes alone", () => {
    expect(libpqUrl("postgresql://u@h/db?sslmode=require")).not.toContain(
      "sslrootcert",
    );
    expect(libpqUrl("postgresql://u@127.0.0.1:55439/db")).not.toContain(
      "sslrootcert",
    );
  });
});
