
# Link Building CRM – Development Roadmap

## Project Overview
Build a complete Link Building Agency CRM with:
- Admin management
- Partner portal
- Client portal
- Publisher management
- Link-building pipeline
- Bulk CSV import
- Anchor text ratio tracking
- Automated outreach
- Live backlink verification
- Invoicing and financial management

---

# PART 1: MASTER PROMPT

# PROJECT: LINK BUILDING AGENCY CRM

Act as a senior software architect, full-stack engineer, PostgreSQL database architect, UI/UX designer and application security engineer.

I want to build a complete, professional, customizable Link Building Agency CRM.

This is a long-term production application, not a demo or static dashboard.

## 1. Technology stack

Use the following architecture:

- Frontend: React + Vite + TypeScript
- Styling: Tailwind CSS
- UI components: shadcn/ui
- Backend: Node.js + Express + TypeScript
- Database: Supabase PostgreSQL
- Authentication: Supabase Auth
- Database security: PostgreSQL Row Level Security (RLS)
- Data fetching: TanStack Query
- Forms: React Hook Form + Zod
- Charts: Recharts
- CSV import/export: PapaParse
- PDF generation: PDFMake
- Excel export: ExcelJS
- Icons: Lucide React
- Version control: Private GitHub repository
- Production hosting: Hostinger Business Node.js hosting

Use a single GitHub monorepo containing frontend, backend, shared types and database migrations.

## 2. Application purpose

The application will manage the complete operational workflow of a link-building agency.

It must support:

- Client management
- Agency partner management
- Publisher management
- Prospect research
- SEO metrics
- Campaign management
- Link placement tracking
- Email outreach management
- Content writing and approvals
- Anchor text analytics
- Live backlink verification
- Invoicing and payments
- Publisher costs and writer payouts
- Profit margin calculations
- Reports and exports
- Customizable Admin dashboard

## 3. Seven user roles

Implement these roles:

1. Super Admin
2. Account Manager
3. Prospector / Lead Researcher
4. Outreach Specialist
5. Content Manager / Writer
6. Client / Agency Partner
7. Publisher / Vendor

Every role must have individual permissions.

The Super Admin must be able to manage user accounts, role assignments, permissions, application settings, navigation, tables, custom fields, colors and layouts.

External clients must never access internal publisher costs, private outreach notes, writer fees or agency profit margins.

## 4. Core application modules

Create the following modules:

- Dashboard
- User Management
- Role & Permission Management
- Clients
- Partners
- Publishers
- Prospect Database
- Campaign Management
- Placement Pipeline
- Outreach Management
- Content Management
- Anchor Text Analytics
- Link Verification
- Invoicing
- Payments
- Publisher Costs
- Writer Payouts
- Financial Analytics
- Reports & Exports
- Notifications
- Admin Customization
- Audit Logs
- System Settings

## 5. Placement workflow

Implement this pipeline:

Prospected → Pitched → Client Approved → Content Writing → Submitted → Live

Maintain placement history, assigned staff, publisher information, campaign relationships, target URLs, anchor text and publication URLs.

## 6. Data management

Use PostgreSQL relational tables with appropriate primary keys, foreign keys, indexes, timestamps and constraints.

Create database migrations and seed scripts.

Include tables for:

- Profiles and roles
- Permissions and role_permissions
- Organizations and memberships
- Clients and partners
- Campaigns and campaign_targets
- Publishers and publisher_metrics
- Prospects and contacts
- Placements and placement_history
- Outreach logs and templates
- Content tasks and drafts
- Anchor texts
- Link verifications
- Invoices and invoice items
- Publisher costs
- Writer payouts
- Payments
- Financial transactions
- System settings
- Table configurations
- Custom field definitions
- Audit logs

## 7. Security requirements

Implement proper backend authorization and Supabase RLS.

Never rely on frontend visibility controls as the only security mechanism.

Keep financial information separate from ordinary placement records.

Protect service-role credentials.

Implement input validation, secure authentication, audit logging and appropriate access restrictions.

## 8. Design requirements

Build a modern, professional SaaS-style CRM interface.

Design requirements:

- Responsive desktop and mobile interface
- Collapsible sidebar
- Top navigation
- Search functionality
- Notifications
- Dashboard cards
- Data tables
- Filters and sorting
- Pagination
- Kanban boards
- Charts
- Modal forms
- Consistent spacing and typography
- Light and dark themes

The Super Admin must be able to customize visible navigation items, table columns, labels, custom fields, colors and layouts through application settings.

Do not permit arbitrary database schema changes through the UI.

## 9. Deployment requirements

The application must be deployable through a private GitHub repository to Hostinger Business Node.js hosting.

Prepare:

- Production build configuration
- Express static frontend serving
- Environment variable documentation
- Database migration instructions
- Deployment documentation
- Health-check endpoint
- Error handling and logging

## 10. Development rules

Do not build the entire application in one operation.

First investigate the requirements and produce:

1. Technical architecture
2. Complete folder structure
3. Database entity relationship design
4. Database table specifications
5. API endpoint specifications
6. Role and permission matrix
7. RLS security strategy
8. UI/UX design system
9. Development milestones
10. Testing strategy
11. Hostinger deployment strategy

Identify missing requirements and potential technical problems.

Use maintainable, modular, production-oriented code.

Do not invent completed integrations or claim a feature works unless it has been implemented and tested.

For this first task, ONLY analyze and prepare the implementation plan. Do not create or modify application code until I review and approve your plan.

---

# PART 2: DEVELOPMENT PHASES

## Phase 1 – Project foundation
Implement Phase 1: Project Foundation.

Create the complete monorepo structure for the Link Building Agency CRM.

Requirements:

1. Set up React, Vite, TypeScript and Tailwind CSS.
2. Set up Node.js, Express and TypeScript.
3. Configure frontend and backend development scripts.
4. Configure shared TypeScript types.
5. Connect Supabase PostgreSQL.
6. Configure environment variables.
7. Create a health-check API.
8. Create centralized error handling.
9. Configure React Router.
10. Create a responsive application layout.
11. Create the sidebar, header, page container and navigation.
12. Add light and dark themes.
13. Configure Git ignore rules.
14. Create a README with setup instructions.

Create a professional SaaS CRM interface with a clean, modern design.

Do not implement all CRM modules yet.

Run the application, test the build, fix errors and explain how to run it locally.

Do not expose any secret keys in frontend code.

## Phase 2 – Authentication and Admin system
Implement Phase 2: Authentication, User Management and RBAC.

Use Supabase Auth and PostgreSQL.

Create the seven user roles:

1. Super Admin
2. Account Manager
3. Prospector
4. Outreach Specialist
5. Content Manager / Writer
6. Client / Agency Partner
7. Publisher / Vendor

Implement:

- Login and logout.
- User registration where permitted.
- Password reset.
- User profiles.
- Role assignments.
- Permission management.
- Protected frontend routes.
- Protected backend API endpoints.
- PostgreSQL RLS policies.
- Admin user management dashboard.
- User activation and suspension.
- Audit logs for sensitive actions.

The Super Admin must be able to create, edit, deactivate and assign users.

Never trust role information supplied by the frontend.

Create test accounts and automated authorization tests for every role.

Ensure clients cannot access internal financial information.

Provide database migrations and explain how to configure Supabase.

## Phase 3 – CRM management modules
Implement Phase 3: Core CRM Management.

Build fully functional modules for:

1. Clients
2. Agency Partners
3. Publishers
4. Prospects
5. Campaigns

Every module should have:

- Create records.
- View records.
- Edit records.
- Delete or archive records with appropriate permissions.
- Search.
- Filters.
- Sorting.
- Pagination.
- Form validation.
- Related record views.
- CSV import/export where appropriate.

For publishers and prospects, include:

- Domain
- Website URL
- Contact email
- Domain Rating
- Organic traffic
- Spam metrics
- Niche/category
- Publisher pricing
- Contact information
- Notes
- Status

Implement bulk CSV import with duplicate detection, row validation, import previews and error reporting.

Connect every module to Supabase.

Do not use static sample data as the permanent data source.

Test CRUD operations and user permissions.

## Phase 4 – Placement pipeline and outreach
Implement Phase 4: Placement Pipeline and Outreach Management.

Create a complete link placement management system.

Pipeline statuses:

Prospected
Pitched
Client Approved
Content Writing
Submitted
Live

Implement:

- Kanban board.
- Placement creation.
- Drag-and-drop status transitions.
- Campaign assignment.
- Publisher assignment.
- Target URL.
- Anchor text.
- Negotiated publisher cost.
- Placement history.
- Assigned team members.
- Internal notes.
- Client approval.
- Status change notifications.

Create an outreach management module with:

- Email templates.
- Outreach records.
- Contact information.
- Follow-up tracking.
- Response status.
- Outreach history.

Do not send real emails without a configured provider and explicit authorization.

Ensure clients only see information approved for their portal.

Create automated tests for placement transitions and permissions.

## Phase 5 – Content, analytics and verification
Implement Phase 5: Content Management, Anchor Analytics and Backlink Verification.

CONTENT MANAGEMENT:

- Writing assignments.
- Writer assignment.
- Content briefs.
- Draft creation.
- Draft versions.
- Revision requests.
- Approval workflow.
- Submission tracking.

ANCHOR TEXT ANALYTICS:

Automatically categorize anchors into:

- Branded
- Exact Match
- Partial Match
- Generic / Naked URL

Calculate anchor distribution by campaign and client.

Create interactive charts and configurable monitoring alerts.

BACKLINK VERIFICATION:

Create a backend verification service that checks:

- Whether the live URL responds.
- Whether the backlink exists.
- Whether the destination URL is correct.
- Whether anchor text matches.
- Whether link attributes match expected values.
- Last verification date.

Save verification history in PostgreSQL.

Implement safe request validation and prevent the verification service from accessing private or internal network addresses.

Add tests for all features.

## Phase 6 – Finance, PDF and CSV exports
Implement Phase 6: Financial Management and Reporting.

Create:

1. Client invoices.
2. Invoice items.
3. Payment tracking.
4. Publisher costs.
5. Writer payouts.
6. Financial transactions.
7. Campaign profitability.
8. Profit margin analytics.

Implement PDFMake for professional PDF invoices and campaign reports.

Implement PapaParse for CSV exports and ExcelJS for Excel exports.

Create different report templates:

- Client-facing campaign report.
- Internal campaign report.
- Publisher report.
- Placement report.
- Financial report.
- Admin database report.

Financial privacy is mandatory.

Only authorized Admins can view agency profit margins, publisher wholesale costs and internal writer payouts.

Clients must never receive internal financial data through API responses or exports.

Test financial calculations and export permissions.

## Phase 7 – Admin customization
Implement Phase 7: Advanced Admin Customization.

Build a customizable Admin control panel.

The Super Admin must be able to:

- Rename navigation tabs.
- Change menu labels.
- Enable and disable modules.
- Customize visible table columns.
- Reorder columns.
- Create custom fields.
- Configure field types.
- Change dashboard layouts.
- Customize theme colors.
- Upload application logos.
- Configure user role visibility.
- Manage notification preferences.
- Configure saved table views.

Store customization settings in PostgreSQL metadata tables.

Do not allow arbitrary SQL execution or physical database schema modification through the Admin interface.

Ensure that customization does not bypass role permissions or RLS.

Test configuration changes and verify they persist after refresh and login.

## Phase 8 – Final testing and deployment
Implement Phase 8: Production Readiness and Deployment.

Review the entire CRM.

Check:

- All seven user roles.
- Authentication.
- Backend authorization.
- Supabase RLS policies.
- Financial privacy.
- Database relationships.
- CRUD operations.
- CSV import/export.
- PDF generation.
- Anchor analytics.
- Placement workflow.
- Link verification.
- Responsive layouts.
- Application error handling.

Run frontend and backend tests.

Run a production build and resolve all errors.

Create:

- Production environment variable guide.
- Supabase migration guide.
- Database backup guide.
- Hostinger deployment instructions.
- GitHub deployment instructions.
- README.
- API documentation.

Configure Express to serve the compiled React frontend and handle API routes.

Prepare the application for Hostinger Business Node.js hosting.

Do not claim production readiness until the build, database connectivity, security checks and essential workflows have actually passed.

Do not expose or commit any secrets.

---

# PART 3: DEVELOPMENT RULES

1. Follow the original master prompt.
2. Complete phases in their specified order.
3. Do not remove existing working features.
4. Maintain database consistency.
5. Maintain role-based access control.
6. Test every feature before marking a phase complete.
7. Document changes and API updates.
8. Never expose sensitive credentials.
9. Update this roadmap when a phase is completed.
