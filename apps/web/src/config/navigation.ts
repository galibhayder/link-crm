import type { Permission } from "@crm/shared";
import {
  BarChart3,
  BookOpen,
  Building2,
  CheckCircle2,
  CreditCard,
  FileText,
  Gauge,
  Globe2,
  Handshake,
  LayoutDashboard,
  Link2,
  PieChart,
  ScanSearch,
  ScrollText,
  Send,
  Settings,
  Settings2,
  ShieldCheck,
  Target,
  Users,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** At least one of these permissions must be held. Empty means always shown. */
  permissions: Permission[];
  /** Marks a module that Phase 1 only stubs out. */
  comingSoon?: boolean;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

/**
 * Navigation is derived from the SAME permission identifiers the API enforces
 * (packages/shared/rbac.ts). If a user cannot call a route, they do not see its
 * menu entry — the menu is not a separate source of truth that can drift.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      { label: "Dashboard", to: "/", icon: LayoutDashboard, permissions: [] },
      {
        // Only roles that can actually approve see this. `placements:approve` is
        // held by owner and account_manager — the two who make client-facing
        // decisions — so the queue appears exactly where it is useful.
        label: "Approvals",
        to: "/approvals",
        icon: CheckCircle2,
        permissions: ["placements:approve"],
      },
      { label: "Reports", to: "/reports", icon: BarChart3, permissions: ["reports:read"] },
      {
        // Margin, publisher costs and payouts. Owner only, and the API enforces
        // the same permission on every figure the page shows.
        label: "Financials",
        to: "/finance",
        icon: Wallet,
        permissions: ["reports:margins"],
      },
    ],
  },
  {
    id: "clients",
    label: "Clients",
    items: [
      { label: "Clients", to: "/clients", icon: Building2, permissions: ["clients:read"], comingSoon: true },
      {
        // Newly tracked. The API is complete and authorises on `clients:*`, but the
        // screen does not exist yet — marked so it is visible and can be built next
        // rather than being invisible.
        label: "Agency Partners",
        to: "/agency-partners",
        icon: Handshake,
        permissions: ["clients:read"],
        comingSoon: true,
      },
      { label: "Campaigns", to: "/campaigns", icon: Target, permissions: ["campaigns:read"], comingSoon: true },
      { label: "Invoices", to: "/invoices", icon: FileText, permissions: ["invoices:read"] },
      { label: "Payments", to: "/payments", icon: CreditCard, permissions: ["payments:read"] },
    ],
  },
  {
    id: "fulfillment",
    label: "Fulfillment",
    items: [
      { label: "Publishers", to: "/publishers", icon: Globe2, permissions: ["publishers:read"], comingSoon: true },
      { label: "Prospects", to: "/prospects", icon: Users, permissions: ["prospects:read"], comingSoon: true },
      { label: "Placements", to: "/placements", icon: Link2, permissions: ["placements:read"] },
      {
        // Links that could not be verified automatically, because the page is
        // rendered by JavaScript. Someone has to open them and look.
        label: "Link reviews",
        to: "/placements/review",
        icon: ScanSearch,
        permissions: ["placements:check"],
      },
      { label: "Outreach", to: "/outreach", icon: Send, permissions: ["touchpoints:read"] },
      { label: "Content", to: "/content", icon: BookOpen, permissions: ["briefs:read"] },
      { label: "Anchors", to: "/anchors", icon: PieChart, permissions: ["reports:read"] },
    ],
  },
  {
    id: "administration",
    label: "Administration",
    items: [
      {
        // Owner-only: this is where the whole product is customized.
        label: "Admin",
        to: "/admin",
        icon: Settings2,
        permissions: ["settings:manage"],
      },
      { label: "Suppliers", to: "/suppliers", icon: Gauge, permissions: ["suppliers:read"], comingSoon: true },
      { label: "Staff & Roles", to: "/staff", icon: ShieldCheck, permissions: ["staff:read"] },
      { label: "Audit log", to: "/audit", icon: ScrollText, permissions: ["audit:read"] },
      { label: "Settings", to: "/settings", icon: Settings, permissions: ["settings:manage"], comingSoon: true },
    ],
  },
];

/**
 * The customization overlay this function understands.
 *
 * Structurally compatible with the API's `EffectiveUi`, but declared narrowly so
 * `navigation.ts` does not depend on the config provider — it stays a pure module
 * that can be unit-tested and used even when no config has loaded.
 */
export interface NavCustomization {
  /** Module ids the SERVER said this user may reach. Null means "no config". */
  modules?: string[] | null;
  labels?: Record<string, string | null> | null;
  sectionLabels?: Record<string, string | null> | null;
  /** Section order, by id. */
  sectionOrder?: Record<string, number> | null;
  itemOrder?: Record<string, number> | null;
}

/**
 * Filters the nav for a role's permission set, dropping empty sections.
 *
 * WITH NO CUSTOMIZATION THIS BEHAVES EXACTLY AS IT ALWAYS HAS. That matters: every
 * screen and every existing test depends on this function, so the config argument
 * is optional and the default path is byte-for-byte the previous behaviour.
 *
 * When a customization IS supplied:
 *
 *   - `modules` is authoritative. The server computed it as RBAC ∩ config, so a
 *     module absent from that list is not rendered — the client does not re-derive
 *     permissions, it obeys the answer.
 *   - labels override the built-in text; a null/absent label keeps the default.
 *   - orders re-sort sections and items; absent order keeps the declared order.
 *
 * The permission filter still runs FIRST. That redundancy is intentional: if the
 * server's module list were ever wrong, the nav would still not show a module the
 * role's permissions exclude.
 */
export function visibleNavigation(permissions: Permission[], customization?: NavCustomization | null): NavSection[] {
  const held = new Set(permissions);
  const allowedModules = customization?.modules ? new Set(customization.modules) : null;

  const sections = NAV_SECTIONS.map((section) => {
    const items = section.items
      .filter((item) => {
        // 1. RBAC — always applied, even when a customization is present.
        const permitted = item.permissions.length === 0 || item.permissions.some((p) => held.has(p));
        if (!permitted) return false;

        // 2. The server's effective module list, when one was supplied.
        if (allowedModules && !allowedModules.has(item.to)) return false;

        return true;
      })
      .map((item) => {
        const custom = customization?.labels?.[item.to];
        const order = customization?.itemOrder?.[item.to];
        return {
          ...item,
          label: custom && custom.trim().length > 0 ? custom : item.label,
          ...(order !== undefined ? { __order: order } : {}),
        };
      })
      .sort((a, b) => {
        const ao = (a as { __order?: number }).__order ?? Number.MAX_SAFE_INTEGER;
        const bo = (b as { __order?: number }).__order ?? Number.MAX_SAFE_INTEGER;
        return ao - bo;
      })
      .map(({ ...item }) => {
        // Strip the sort helper so the returned shape is exactly `NavItem`.
        delete (item as { __order?: number }).__order;
        return item as NavItem;
      });

    const customSectionLabel = customization?.sectionLabels?.[section.id];
    return {
      ...section,
      label: customSectionLabel && customSectionLabel.trim().length > 0 ? customSectionLabel : section.label,
      items,
    };
  })
    .filter((section) => section.items.length > 0)
    .sort((a, b) => {
      const ao = customization?.sectionOrder?.[a.id] ?? Number.MAX_SAFE_INTEGER;
      const bo = customization?.sectionOrder?.[b.id] ?? Number.MAX_SAFE_INTEGER;
      return ao - bo;
    });

  return sections;
}
