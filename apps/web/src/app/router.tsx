import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import { RequireAuth, RequireSurface, RedirectIfAuthenticated, RequirePermission } from "./guards";
import { LoginPage } from "@/features/auth/login-page";
import { ForgotPasswordPage } from "@/features/auth/forgot-password-page";
import { ResetPasswordPage } from "@/features/auth/reset-password-page";
import { RegisterPage } from "@/features/auth/register-page";
import { DashboardPage, ModulePlaceholder } from "@/features/dashboard/dashboard-page";
import { StaffPage } from "@/features/staff/staff-page";
import { AuditLogPage } from "@/features/audit/audit-log-page";
import { ProfilePage } from "@/features/profile/profile-page";
import { NotFoundPage } from "@/features/misc/not-found-page";
import { PlacementsPage } from "@/features/placements/placements-page";
import { OutreachPage } from "@/features/outreach/outreach-page";
import { ContentPage } from "@/features/content/content-page";
import { AnchorsPage } from "@/features/anchors/anchors-page";
import { ApprovalsPage } from "@/features/approvals/approvals-page";
import { InvoicesPage } from "@/features/invoices/invoices-page";
import { InvoiceDetailPage } from "@/features/invoices/invoice-detail-page";
import { InvoiceEditorPage } from "@/features/invoices/invoice-editor-page";
import { PaymentsPage } from "@/features/payments/payments-page";
import { FinancePage } from "@/features/finance/finance-page";
import { ReportsPage } from "@/features/reports/reports-page";
import { AdminPage } from "@/features/admin/admin-page";
import { PublicInvoicePage } from "@/features/invoices/public-invoice-page";
import { PortalShell } from "@/portals/client/portal-shell";
import { PortalHomePage } from "@/portals/client/portal-home";
import { PortalCampaignsPage } from "@/portals/client/portal-campaigns";
import { PortalDraftsPage } from "@/portals/client/portal-drafts";
import { PortalDraftDetailPage } from "@/portals/client/portal-draft-detail";
import { PortalInvoicesPage } from "@/portals/client/portal-invoices";

/**
 * Route tree.
 *
 * TWO TREES, deliberately separated:
 *
 *   /        RequireSurface("internal") -> AppShell   -> staff modules
 *   /portal  RequireSurface("portal")   -> PortalShell -> client modules
 *
 * The split is not cosmetic. The internal `AppShell` builds its sidebar from the
 * staff permission matrix, so mounting it for a client would either render links
 * that 403 or need a per-item check that could drift from the API. A separate tree
 * with its own shell makes "a client never sees an internal menu item" a structural
 * fact rather than a condition someone has to remember.
 *
 * `RequireSurface` is the route-layer guard. It is NOT the security boundary —
 * `authenticate` rejects a portal token on `/api/v1` before any handler runs, which
 * is what actually protects the data.
 */
const router = createBrowserRouter([
  {
    path: "/login",
    element: (
      <RedirectIfAuthenticated>
        <LoginPage />
      </RedirectIfAuthenticated>
    ),
  },
  // Public auth screens. reset-password must stay reachable while a recovery
  // session is being established, so it is NOT wrapped in RedirectIfAuthenticated.
  { path: "/forgot-password", element: <ForgotPasswordPage /> },
  { path: "/reset-password", element: <ResetPasswordPage /> },

  // ---------------------------------------------------------------------------
  // PUBLIC INVOICE LINK — /i/:token
  //
  // Deliberately OUTSIDE every authenticated tree and with no shell. The recipient
  // has no account, must not see the CRM navigation, and must not be redirected to
  // sign in. The token in the URL is the credential; the API decides what it may
  // return, and that is only the frozen, client-safe snapshot.
  // ---------------------------------------------------------------------------
  { path: "/i/:token", element: <PublicInvoicePage /> },
  {
    path: "/register",
    element: (
      <RedirectIfAuthenticated>
        <RegisterPage />
      </RedirectIfAuthenticated>
    ),
  },

  // ---------------------------------------------------------------------------
  // CLIENT PORTAL
  //
  // Declared as a sibling of "/" so a deep link resolves before the catch-all.
  // ---------------------------------------------------------------------------
  {
    path: "/portal",
    element: <RequireAuth />,
    children: [
      {
        element: <RequireSurface surface="portal" />,
        children: [
          {
            element: <PortalShell />,
            children: [
              { index: true, element: <PortalHomePage /> },
              { path: "campaigns", element: <PortalCampaignsPage /> },
              { path: "drafts", element: <PortalDraftsPage /> },
              { path: "drafts/:id", element: <PortalDraftDetailPage /> },
              { path: "invoices", element: <PortalInvoicesPage /> },
            ],
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // INTERNAL CRM
  // ---------------------------------------------------------------------------
  {
    path: "/",
    element: <RequireAuth />,
    children: [
      {
        element: <RequireSurface surface="internal" />,
        children: [
          {
            element: <AppShell />,
            children: [
              { index: true, element: <DashboardPage /> },
              {
                path: "approvals",
                element: (
                  <RequirePermission permission="placements:approve">
                    <ApprovalsPage />
                  </RequirePermission>
                ),
              },
              {
                path: "reports",
                element: (
                  <RequirePermission permission="reports:read">
                    <ReportsPage />
                  </RequirePermission>
                ),
              },
              {
                path: "clients",
                element: (
                  <RequirePermission permission="clients:read">
                    <ModulePlaceholder
                      title="Clients"
                      description="Client records, billing profiles, contacts and portal access."
                    />
                  </RequirePermission>
                ),
              },
              {
                path: "agency-partners",
                element: (
                  <RequirePermission permission="clients:read">
                    <ModulePlaceholder
                      title="Agency Partners"
                      description="White-label and reseller partners, their pricing model and their clients."
                    />
                  </RequirePermission>
                ),
              },
              {
                path: "campaigns",
                element: (
                  <RequirePermission permission="campaigns:read">
                    <ModulePlaceholder
                      title="Campaigns"
                      description="Campaign targets, monthly delivery goals and team assignments."
                    />
                  </RequirePermission>
                ),
              },
              {
                path: "publishers",
                element: (
                  <RequirePermission permission="publishers:read">
                    <ModulePlaceholder
                      title="Publishers"
                      description="The publisher database with domain metrics and price history."
                    />
                  </RequirePermission>
                ),
              },
              {
                path: "prospects",
                element: (
                  <RequirePermission permission="prospects:read">
                    <ModulePlaceholder
                      title="Prospects"
                      description="The outreach pipeline, from prospected through to live."
                    />
                  </RequirePermission>
                ),
              },
              {
                path: "placements",
                element: (
                  <RequirePermission permission="placements:read">
                    <PlacementsPage />
                  </RequirePermission>
                ),
              },
              {
                path: "outreach",
                element: (
                  <RequirePermission permission="touchpoints:read">
                    <OutreachPage />
                  </RequirePermission>
                ),
              },
              {
                path: "content",
                element: (
                  <RequirePermission permission="briefs:read">
                    <ContentPage />
                  </RequirePermission>
                ),
              },
              {
                path: "anchors",
                element: (
                  <RequirePermission permission="reports:read">
                    <AnchorsPage />
                  </RequirePermission>
                ),
              },
              {
                path: "suppliers",
                element: (
                  <RequirePermission permission="suppliers:read">
                    <ModulePlaceholder
                      title="Suppliers"
                      description="Direct publishers and link vendors, with payment terms."
                    />
                  </RequirePermission>
                ),
              },
              {
                path: "invoices",
                element: (
                  <RequirePermission permission="invoices:read">
                    <InvoicesPage />
                  </RequirePermission>
                ),
              },
              {
                path: "invoices/new",
                element: (
                  <RequirePermission permission="invoices:write">
                    <InvoiceEditorPage />
                  </RequirePermission>
                ),
              },
              {
                path: "invoices/:id",
                element: (
                  <RequirePermission permission="invoices:read">
                    <InvoiceDetailPage />
                  </RequirePermission>
                ),
              },
              {
                path: "payments",
                element: (
                  <RequirePermission permission="payments:read">
                    <PaymentsPage />
                  </RequirePermission>
                ),
              },
              {
                // Margin-adjacent, so `reports:margins` — owner only. The API
                // enforces the same permission on every figure on the page.
                path: "finance",
                element: (
                  <RequirePermission permission="reports:margins">
                    <FinancePage />
                  </RequirePermission>
                ),
              },
              {
                path: "admin",
                element: (
                  <RequirePermission permission="settings:manage">
                    <AdminPage />
                  </RequirePermission>
                ),
              },
              {
                path: "staff",
                element: (
                  <RequirePermission permission="staff:read">
                    <StaffPage />
                  </RequirePermission>
                ),
              },
              {
                path: "audit",
                element: (
                  <RequirePermission permission="audit:read">
                    <AuditLogPage />
                  </RequirePermission>
                ),
              },
              { path: "profile", element: <ProfilePage /> },
              {
                path: "settings",
                element: (
                  <RequirePermission permission="settings:manage">
                    <ModulePlaceholder
                      title="Settings"
                      description="Organisation details, branding, currency and pipeline stages."
                    />
                  </RequirePermission>
                ),
              },
              { path: "404", element: <NotFoundPage /> },
              { path: "*", element: <Navigate to="/404" replace /> },
            ],
          },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/404" replace /> },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
