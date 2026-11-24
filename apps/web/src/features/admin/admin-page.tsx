import { useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Columns3,
  Eye,
  EyeOff,
  GripVertical,
  Image as ImageIcon,
  LayoutDashboard,
  Palette,
  RotateCcw,
  Save,
  ShieldAlert,
  Tags,
  Trash2,
  Upload,
} from "lucide-react";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, PageHeading, Skeleton } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { ErrorState } from "@/components/ui/states";
import { useAuth } from "@/providers/auth";
import { useOptionalUiConfig } from "@/providers/ui-config";
import { cn } from "@/lib/utils";
import { adminErrorMessage, useAdminActions, useAdminConfig, useRegistries } from "./use-admin";
import type { ModuleId, UIConfig } from "@crm/shared";

/**
 * The config's index types are `Record<closed-enum, …>`, so a plain `string` key
 * needs narrowing at the boundary. These aliases keep the casts in one place
 * instead of scattering `as never` through the components — which is what produced
 * a page of `Property 'columns' does not exist on type 'never'` errors.
 */
type UIConfigModuleId = ModuleId;
type TableConfig = NonNullable<UIConfig["tables"]>[ModuleId];
type RoleVisibility = NonNullable<UIConfig["roleVisibility"]>;

/**
 * ADMIN CUSTOMIZATION PANEL.
 *
 * Nine sections, one working document, one Save.
 *
 * WHY A SINGLE DRAFT RATHER THAN PER-SECTION SAVES: navigation labels, section
 * order and per-role visibility are interrelated — hiding the last item in a
 * section removes the section. Saving them independently would let an admin land
 * in a state no single edit produced. One document, saved atomically, is the only
 * model where "what you see" and "what is stored" cannot diverge.
 *
 * The panel never decides what a user may see. It writes a description; the API
 * intersects that description with RBAC and returns the result. Every control
 * here is therefore cosmetic or subtractive by construction.
 */

type Tab = "navigation" | "modules" | "tables" | "dashboard" | "theme" | "branding" | "roles";

const TABS: Array<{ key: Tab; label: string; icon: typeof Tags }> = [
  { key: "navigation", label: "Navigation", icon: Tags },
  { key: "modules", label: "Modules", icon: EyeOff },
  { key: "tables", label: "Columns", icon: Columns3 },
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "theme", label: "Theme", icon: Palette },
  { key: "branding", label: "Branding", icon: ImageIcon },
  { key: "roles", label: "Roles", icon: ShieldAlert },
];

export function AdminPage() {
  const { can } = useAuth();
  const config = useAdminConfig();
  const registries = useRegistries();
  const actions = useAdminActions();
  const ui = useOptionalUiConfig();

  const [tab, setTab] = useState<Tab>("navigation");
  const [draft, setDraft] = useState<UIConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The draft starts from the server value and is only replaced when the admin
  // has nothing unsaved — otherwise a background refetch would silently discard
  // their edits.
  const working = draft ?? config.data?.config ?? {};
  const dirty = draft !== null;

  const update = (patch: Partial<UIConfig>) => {
    setDraft((prev) => ({ ...(prev ?? config.data?.config ?? {}), ...patch }));
    setSaved(false);
  };

  const handleSave = async () => {
    setError(null);
    try {
      await actions.saveConfig.mutateAsync(working);
      setSaved(true);
      setDraft(null);
    } catch (err) {
      setError(adminErrorMessage(err));
    }
  };

  const handleReset = async (section: string) => {
    setError(null);
    try {
      await actions.resetSection.mutateAsync(section);
      setDraft(null);
      setSaved(true);
    } catch (err) {
      setError(adminErrorMessage(err));
    }
  };

  if (config.isError) {
    return (
      <PageContainer>
        <PageStack>
          <PageHeading title="Admin" />
          <ErrorState description={adminErrorMessage(config.error)} onRetry={() => void config.refetch()} />
        </PageStack>
      </PageContainer>
    );
  }

  if (!can("settings:manage")) {
    return (
      <PageContainer>
        <PageStack>
          <PageHeading title="Admin" />
          <ErrorState description="Only the account owner can customize the application." />
        </PageStack>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="Admin"
          description="Customize the interface for your organisation. These settings change what people see — never what they are permitted to do."
          actions={
            <div className="flex items-center gap-2">
              {dirty && <Badge tone="warning">Unsaved changes</Badge>}
              <Button
                variant="secondary"
                size="sm"
                loading={actions.resetSection.isPending}
                onClick={() => void handleReset("all")}
              >
                <RotateCcw />
                Reset all
              </Button>
              <Button size="sm" disabled={!dirty} loading={actions.saveConfig.isPending} onClick={() => void handleSave()}>
                <Save />
                Save changes
              </Button>
            </div>
          }
        />

        {config.data && !config.data.valid && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning-soft)]/50 px-3 py-2 text-[12.5px] text-[var(--color-warning)]"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              The stored configuration could not be read and defaults are being served. Saving from
              this screen will replace it.
            </p>
          </div>
        )}

        {saved && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success-soft)]/50 px-3 py-2 text-[12.5px] text-[var(--color-success)]"
          >
            <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>Saved. The change applies immediately and persists across reload and sign-in.</p>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)]/50 px-3 py-2 text-[12.5px] text-[var(--color-danger)]"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{error}</p>
          </div>
        )}

        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Customization section">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition",
                tab === t.key
                  ? "border-brand-400 bg-brand-600/10 text-brand-700 dark:text-brand-300"
                  : "border-line bg-surface text-muted hover:text-foreground",
              )}
            >
              <t.icon className="size-3.5" aria-hidden />
              {t.label}
            </button>
          ))}
        </div>

        {config.isLoading || registries.isLoading ? (
          <Card>
            <CardContent className="space-y-2 p-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </CardContent>
          </Card>
        ) : (
          <>
            {tab === "navigation" && (
              <NavigationSection working={working} registries={registries.data} update={update} />
            )}
            {tab === "modules" && <ModulesSection working={working} registries={registries.data} update={update} />}
            {tab === "tables" && <TablesSection working={working} registries={registries.data} update={update} />}
            {tab === "dashboard" && <DashboardSection working={working} registries={registries.data} update={update} />}
            {tab === "theme" && <ThemeSection working={working} update={update} preview={ui?.config.theme} />}
            {tab === "branding" && (
              <BrandingSection
                working={working}
                update={update}
                logoUrl={ui?.logoUrl ?? null}
                actions={actions}
                onError={setError}
              />
            )}
            {tab === "roles" && <RolesSection working={working} registries={registries.data} update={update} />}
          </>
        )}
      </PageStack>
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Navigation — rename, hide, reorder
// ---------------------------------------------------------------------------
function NavigationSection({
  working,
  registries,
  update,
}: {
  working: UIConfig;
  registries: ReturnType<typeof useRegistries>["data"];
  update: (patch: Partial<UIConfig>) => void;
}) {
  const items = working.navigation?.items ?? [];
  const sections = working.navigation?.sections ?? [];

  const moduleLabel = (id: string) =>
    items.find((i) => i.to === id)?.label ??
    // Fall back to a readable name derived from the route.
    id === "/"
      ? "Dashboard"
      : id
          .slice(1)
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");

  const setItem = (id: string, patch: { label?: string; hidden?: boolean }) => {
    const existing = items.find((i) => i.to === id);
    // Spread over the union rather than rewriting it: `to` is a closed enum, and
    // replacing the element wholesale is what keeps the discriminated type intact.
    const next = existing
      ? items.map((i) => (i.to === id ? { ...i, ...patch } : i))
      : [...items, { to: id as UIConfigModuleId, ...patch }];
    update({ navigation: { ...working.navigation, items: next } });
  };

  const setSection = (id: string, label: string) => {
    const existing = sections.find((s) => s.id === id);
    const next = existing
      ? sections.map((s) => (s.id === id ? { ...s, label } : s))
      : [...sections, { id: id as never, label }];
    update({ navigation: { ...working.navigation, sections: next } });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Section names</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 pt-0 sm:grid-cols-2">
          {(registries?.sections ?? []).map((section) => {
            const current = sections.find((s) => s.id === section.id)?.label ?? "";
            return (
              <Field key={section.id} label={section.label} hint={`id: ${section.id}`}>
                <Input
                  value={current}
                  placeholder={section.label}
                  onChange={(e) => setSection(section.id, e.target.value)}
                  aria-label={`Rename ${section.label} section`}
                />
              </Field>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Menu items</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="mb-3 text-[12px] text-muted">
            Rename an item, or hide it from everyone. Hiding is cosmetic: the API still enforces
            permissions, so this cannot grant access.
          </p>
          <ul className="divide-y divide-line">
            {(registries?.modules ?? []).map((module) => {
              const item = items.find((i) => i.to === module.id);
              return (
                <li key={module.id} className="flex flex-wrap items-center gap-2 py-2">
                  <code className="w-40 shrink-0 truncate text-[11px] text-muted">{module.id}</code>

                  <Input
                    value={item?.label ?? ""}
                    placeholder={moduleLabel(module.id)}
                    onChange={(e) => setItem(module.id, { label: e.target.value })}
                    className="min-w-[140px] flex-1"
                    aria-label={`Label for ${module.id}`}
                  />

                  <Button
                    variant={item?.hidden ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setItem(module.id, { hidden: !item?.hidden })}
                    aria-pressed={Boolean(item?.hidden)}
                  >
                    {item?.hidden ? <EyeOff /> : <Eye />}
                    {item?.hidden ? "Hidden" : "Visible"}
                  </Button>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modules — enable / disable
// ---------------------------------------------------------------------------
function ModulesSection({
  working,
  registries,
  update,
}: {
  working: UIConfig;
  registries: ReturnType<typeof useRegistries>["data"];
  update: (patch: Partial<UIConfig>) => void;
}) {
  const modules = working.modules ?? {};

  return (
    <Card>
      <CardHeader>
        <CardTitle>Disabled modules</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="mb-3 text-[12px] text-muted">
          Disabling a module removes it from the menu <strong>and</strong> makes its API routes
          refuse. The Admin panel itself cannot be disabled.
        </p>
        <ul className="divide-y divide-line">
          {(registries?.modules ?? [])
            .filter((m) => m.id !== "/admin")
            .map((module) => {
              const disabled = modules[module.id as UIConfigModuleId] === false;
              return (
                <li key={module.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <code className="text-[12px] text-foreground-soft">{module.id}</code>
                    {module.permission && (
                      <p className="text-[10.5px] text-muted">requires {module.permission}</p>
                    )}
                  </div>
                  <Button
                    variant={disabled ? "danger" : "secondary"}
                    size="sm"
                    onClick={() =>
                      update({
                        modules: {
                          ...modules,
                          [module.id as UIConfigModuleId]: disabled,
                        } as UIConfig["modules"],
                      })
                    }
                  >
                    {disabled ? "Disabled" : "Enabled"}
                  </Button>
                </li>
              );
            })}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tables — columns and order
// ---------------------------------------------------------------------------
function TablesSection({
  working,
  registries,
  update,
}: {
  working: UIConfig;
  registries: ReturnType<typeof useRegistries>["data"];
  update: (patch: Partial<UIConfig>) => void;
}) {
  const tables = working.tables ?? {};
  const configurableModules = Object.keys(registries?.columns ?? {});

  const toggleColumn = (moduleId: string, column: string) => {
    const key = moduleId as UIConfigModuleId;
    const current: string[] = tables[key]?.columns ?? [];
    const next = current.includes(column) ? current.filter((c) => c !== column) : [...current, column];
    update({
      tables: {
        ...tables,
        [key]: { ...(tables[key] as TableConfig), columns: next },
      } as UIConfig["tables"],
    });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <p className="text-[12px] text-muted">
            Choose which columns each table shows. Reordering is applied by the order you select
            them. The API still decides which columns exist — this cannot reveal a field it does
            not already return.
          </p>
        </CardContent>
      </Card>

      {configurableModules.map((moduleId) => {
        const available = registries?.columns?.[moduleId] ?? [];
        const selected: string[] = tables[moduleId as UIConfigModuleId]?.columns ?? [];

        return (
          <Card key={moduleId}>
            <CardHeader>
              <CardTitle className="text-[13px]">{moduleId}</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex flex-wrap gap-1.5">
                {available.map((column) => {
                  const on = selected.includes(column);
                  const index = selected.indexOf(column);
                  return (
                    <button
                      key={column}
                      type="button"
                      onClick={() => toggleColumn(moduleId, column)}
                      aria-pressed={on}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] transition",
                        on
                          ? "border-brand-400 bg-brand-600/10 text-brand-700 dark:text-brand-300"
                          : "border-line bg-surface text-muted hover:text-foreground",
                      )}
                    >
                      {on && (
                        <span className="rounded bg-brand-600 px-1 text-[9.5px] font-semibold text-white tabular-nums">
                          {index + 1}
                        </span>
                      )}
                      {column}
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard — widget visibility and order
// ---------------------------------------------------------------------------
function DashboardSection({
  working,
  registries,
  update,
}: {
  working: UIConfig;
  registries: ReturnType<typeof useRegistries>["data"];
  update: (patch: Partial<UIConfig>) => void;
}) {
  const hidden = working.dashboard?.hidden ?? [];
  const order = working.dashboard?.order ?? [];

  const toggle = (widget: string) => {
    const next = hidden.includes(widget as never)
      ? hidden.filter((w) => w !== widget)
      : [...hidden, widget as never];
    update({ dashboard: { ...working.dashboard, hidden: next } });
  };

  const move = (widget: string, direction: -1 | 1) => {
    const current = order.length > 0 ? [...order] : (registries?.widgets ?? []).map((w) => w.id);
    const index = current.indexOf(widget as never);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.length) return;
    [current[index], current[target]] = [current[target]!, current[index]!];
    update({ dashboard: { ...working.dashboard, order: current as never } });
  };

  const ordered = order.length > 0 ? order : (registries?.widgets ?? []).map((w) => w.id);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dashboard widgets</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="mb-3 text-[12px] text-muted">
          Show, hide and order the blocks on the dashboard. Layouts choose and order widgets; they do
          not resize them.
        </p>
        <ul className="divide-y divide-line">
          {ordered.map((widgetId, index) => {
            const meta = registries?.widgets.find((w) => w.id === widgetId);
            const isHidden = hidden.includes(widgetId as never);
            return (
              <li key={widgetId} className="flex items-center gap-2 py-2">
                <GripVertical className="size-3.5 shrink-0 text-muted" aria-hidden />
                <span className="flex size-5 shrink-0 items-center justify-center rounded bg-surface-sunken text-[10px] font-semibold tabular-nums text-muted">
                  {index + 1}
                </span>
                <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", isHidden ? "text-muted line-through" : "text-foreground-soft")}>
                  {meta?.label ?? widgetId}
                </span>
                <Button variant="ghost" size="icon-sm" aria-label={`Move ${widgetId} up`} onClick={() => move(widgetId, -1)}>
                  ↑
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Move ${widgetId} down`} onClick={() => move(widgetId, 1)}>
                  ↓
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggle(widgetId)}
                  aria-pressed={isHidden}
                >
                  {isHidden ? <EyeOff /> : <Eye />}
                </Button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
const ACCENT_PRESETS = [
  { label: "Trivero indigo", value: "#4F5BEE" },
  { label: "Violet", value: "#7C3AED" },
  { label: "Emerald", value: "#059669" },
  { label: "Amber", value: "#D97706" },
  { label: "Rose", value: "#E11D48" },
  { label: "Slate", value: "#475569" },
];

function ThemeSection({
  working,
  update,
  preview,
}: {
  working: UIConfig;
  update: (patch: Partial<UIConfig>) => void;
  preview?: { accent?: string };
}) {
  const theme = working.theme ?? {};

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Accent colour</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <p className="text-[12px] text-muted">
            Used for buttons, links, focus rings and the invoice PDF. Changing it here changes both
            the app and the invoices your clients receive.
          </p>

          <div className="flex flex-wrap gap-2">
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                onClick={() => update({ theme: { ...theme, accent: preset.value } })}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] transition",
                  theme.accent === preset.value
                    ? "border-brand-400 ring-1 ring-brand-400"
                    : "border-line hover:border-line-strong",
                )}
              >
                <span className="size-4 rounded-full" style={{ backgroundColor: preset.value }} aria-hidden />
                {preset.label}
              </button>
            ))}
          </div>

          <Field label="Custom hex" hint="Six-digit hex, e.g. #4F5BEE.">
            <Input
              value={theme.accent ?? ""}
              placeholder="#4F5BEE"
              maxLength={7}
              onChange={(e) => update({ theme: { ...theme, accent: e.target.value } })}
            />
          </Field>

          {preview?.accent && (
            <p className="text-[11px] text-muted">
              Currently applied: <code>{preview.accent}</code>
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Corner radius</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex gap-2">
            {(["sharp", "default", "round"] as const).map((value) => (
              <Button
                key={value}
                variant={theme.radius === value ? "primary" : "secondary"}
                size="sm"
                onClick={() => update({ theme: { ...theme, radius: value } })}
              >
                {value}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Branding — app name and logo
// ---------------------------------------------------------------------------
function BrandingSection({
  working,
  update,
  logoUrl,
  actions,
  onError,
}: {
  working: UIConfig;
  update: (patch: Partial<UIConfig>) => void;
  logoUrl: string | null;
  actions: ReturnType<typeof useAdminActions>;
  onError: (message: string) => void;
}) {
  const branding = working.branding ?? {};

  const handleFile = async (file: File) => {
    // A client-side size guard so an obviously-too-big file fails instantly rather
    // than after a 300 KB upload. The server enforces the same limit regardless.
    if (file.size > 256 * 1024) {
      onError(`That image is ${Math.round(file.size / 1024)} KB. The limit is 256 KB.`);
      return;
    }

    const dataUri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Could not read the file"));
      reader.readAsDataURL(file);
    });

    try {
      await actions.uploadLogo.mutateAsync(dataUri);
    } catch (err) {
      onError(adminErrorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Application name</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <Field label="Name" hint="Shown in the sidebar, the page title and invoice headers.">
            <Input
              value={branding.appName ?? ""}
              placeholder="Trivero Marketing"
              onChange={(e) => update({ branding: { ...branding, appName: e.target.value } })}
            />
          </Field>
          <Field label="Tagline">
            <Input
              value={branding.tagline ?? ""}
              placeholder="Link Building CRM"
              onChange={(e) => update({ branding: { ...branding, tagline: e.target.value } })}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Logo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <p className="text-[12px] text-muted">
            PNG, JPEG, WebP, GIF or SVG, up to 256 KB. Used in the sidebar and on every invoice PDF.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex size-16 items-center justify-center overflow-hidden rounded-lg border border-line bg-white p-1.5">
              {logoUrl ? (
                <img src={logoUrl} alt="Current logo" className="size-full object-contain" />
              ) : (
                <ImageIcon className="size-6 text-muted" aria-hidden />
              )}
            </div>

            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-foreground-soft hover:bg-surface-sunken">
              <Upload className="size-3.5" aria-hidden />
              Upload
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                  e.target.value = "";
                }}
              />
            </label>

            {logoUrl && (
              <Button
                variant="ghost"
                size="sm"
                className="text-[var(--color-danger)]"
                loading={actions.removeLogo.isPending}
                onClick={() =>
                  void actions.removeLogo.mutateAsync().catch((err) => onError(adminErrorMessage(err)))
                }
              >
                <Trash2 />
                Remove
              </Button>
            )}
          </div>

          <p className="text-[11px] text-muted">
            The logo uploads immediately — it is not part of the saved draft.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roles — narrowing only
// ---------------------------------------------------------------------------
function RolesSection({
  working,
  registries,
  update,
}: {
  working: UIConfig;
  registries: ReturnType<typeof useRegistries>["data"];
  update: (patch: Partial<UIConfig>) => void;
}) {
  const visibility = working.roleVisibility ?? {};
  const roles = ["owner", "account_manager", "prospector", "outreach_specialist", "content_writer"];

  const toggle = (role: string, moduleId: string) => {
    const roleKey = role as keyof RoleVisibility;
    const current: string[] = visibility[roleKey] ?? [];
    const next = current.includes(moduleId)
      ? current.filter((m) => m !== moduleId)
      : [...current, moduleId];
    update({ roleVisibility: { ...visibility, [roleKey]: next } as UIConfig["roleVisibility"] });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Hide modules per role</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
          <p className="text-[11.5px] leading-relaxed text-muted">
            These switches can only <strong>hide</strong> a module from a role that would otherwise
            see it. A module a role has no permission for is already unavailable and is shown greyed
            out — there is no way to grant access from this screen.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[12px]">
            <thead className="border-b border-line">
              <tr className="text-[10.5px] uppercase tracking-wide text-muted">
                <th className="py-2 pr-3 font-medium">Module</th>
                {roles.map((role) => (
                  <th key={role} className="px-2 py-2 text-center font-medium">
                    {role.replace(/_/g, " ")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(registries?.modules ?? [])
                .filter((m) => m.id !== "/admin")
                .map((module) => (
                  <tr key={module.id}>
                    <td className="py-1.5 pr-3">
                      <code className="text-[11.5px] text-foreground-soft">{module.id}</code>
                    </td>
                    {roles.map((role) => {
                      // A role that cannot reach the module at all — the toggle is
                      // meaningless there, and greying it out says why.
                      const reachable = registries?.rolePermissions?.[role]?.includes(module.id) ?? false;
                      const hiddenForRole: string[] = visibility[role as keyof RoleVisibility] ?? [];
                      const isHidden = hiddenForRole.includes(module.id);

                      return (
                        <td key={role} className="px-2 py-1.5 text-center">
                          <input
                            type="checkbox"
                            checked={isHidden}
                            disabled={!reachable}
                            onChange={() => toggle(role, module.id)}
                            aria-label={`Hide ${module.id} from ${role}`}
                            className="size-3.5 rounded border-line-strong accent-brand-600 disabled:opacity-30"
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          Checked = hidden from that role. Greyed out = that role has no access anyway.
        </p>
      </CardContent>
    </Card>
  );
}
