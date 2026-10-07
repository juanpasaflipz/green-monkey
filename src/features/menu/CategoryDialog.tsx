import { useState } from "react";
import type { Locale } from "../../../shared/domain";
import type { MenuCategory } from "../../../shared/menu";
import { categoryInput } from "../../../shared/menu-schema";
import { api } from "../../api";
import { errorNotice } from "../../i18n";
import { Button, Field, Modal } from "../../components/ui";
import { translator } from "./format";

/** Create or rename a category. One operationId per open dialog, reused on retry. */
export function CategoryDialog({
  category,
  locale,
  online,
  onSaved,
  onClose,
}: {
  category?: MenuCategory;
  locale: Locale;
  online: boolean;
  onSaved: (category: MenuCategory) => void;
  onClose: () => void;
}) {
  const t = translator(locale);
  const [operationId] = useState(() => crypto.randomUUID());
  const [newId] = useState(() => crypto.randomUUID());
  const [es, setEs] = useState(category?.name.es ?? "");
  const [en, setEn] = useState(
    category && category.name.en !== category.name.es ? category.name.en : "",
  );
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save() {
    const body = {
      operationId,
      id: category?.id ?? newId,
      expectedVersion: category?.version ?? 0,
      name: { es, en },
    };
    const parsed = categoryInput.safeParse(body);
    setInvalid(!parsed.success);
    if (!parsed.success) return;
    setBusy(true);
    setError("");
    try {
      onSaved(await api<MenuCategory>("/menu/categories/save", body));
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t(category ? "menuEditCategory" : "menuNewCategory")}
      close={onClose}
      closeLabel={t("close")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={t("menuCategoryName")}>
          <input
            value={es}
            maxLength={80}
            required
            aria-invalid={invalid && !es.trim() ? true : undefined}
            onChange={(e) => setEs(e.target.value)}
          />
        </Field>
        <Field label={t("menuCategoryNameEn")}>
          <input
            value={en}
            maxLength={80}
            onChange={(e) => setEn(e.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {!online && <p className="muted">{t("menuOfflineHint")}</p>}
        <Button
          type="submit"
          variant="primary"
          className="full"
          disabled={busy || !online}
        >
          {t("menuSave")}
        </Button>
      </form>
    </Modal>
  );
}
