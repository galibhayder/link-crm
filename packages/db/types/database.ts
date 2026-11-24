
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "activity_log": {
                  Row: {
                    "action": string,"actor_id": string | null,"actor_name_snapshot": string | null,"actor_role": string | null,"created_at": string,"diff": NonNullable<Json>,"entity_id": string | null,"entity_type": string,"id": string,"ip": unknown,"organization_id": string,"user_agent": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"actor_name_snapshot"?: string | null,"actor_role"?: string | null,"created_at"?: string,"diff"?: NonNullable<Json>,"entity_id"?: string | null,"entity_type": string,"id"?: string,"ip"?: unknown,"organization_id": string,"user_agent"?: string | null
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"actor_name_snapshot"?: string | null,"actor_role"?: string | null,"created_at"?: string,"diff"?: NonNullable<Json>,"entity_id"?: string | null,"entity_type"?: string,"id"?: string,"ip"?: unknown,"organization_id"?: string,"user_agent"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "activity_log_actor_id_fkey"
      columns: ["actor_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "activity_log_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"agency_partners": {
                  Row: {
                    "account_manager_id": string | null,"billing_email": string | null,"contact_email": string | null,"contact_name": string | null,"contact_phone": string | null,"created_at": string,"currency": string,"deleted_at": string | null,"discount_pct": number | null,"domain": string,"fixed_rate": number | null,"id": string,"markup_pct": number | null,"name": string,"notes": string | null,"organization_id": string,"partner_type": string,"payment_terms_days": number,"pricing_model": string,"start_date": string | null,"status": string,"updated_at": string,"white_label_reports": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "account_manager_id"?: string | null,"billing_email"?: string | null,"contact_email"?: string | null,"contact_name"?: string | null,"contact_phone"?: string | null,"created_at"?: string,"currency"?: string,"deleted_at"?: string | null,"discount_pct"?: number | null,"domain": string,"fixed_rate"?: number | null,"id"?: string,"markup_pct"?: number | null,"name": string,"notes"?: string | null,"organization_id": string,"partner_type"?: string,"payment_terms_days"?: number,"pricing_model"?: string,"start_date"?: string | null,"status"?: string,"updated_at"?: string,"white_label_reports"?: boolean
                  }
                  Update: {
                    "account_manager_id"?: string | null,"billing_email"?: string | null,"contact_email"?: string | null,"contact_name"?: string | null,"contact_phone"?: string | null,"created_at"?: string,"currency"?: string,"deleted_at"?: string | null,"discount_pct"?: number | null,"domain"?: string,"fixed_rate"?: number | null,"id"?: string,"markup_pct"?: number | null,"name"?: string,"notes"?: string | null,"organization_id"?: string,"partner_type"?: string,"payment_terms_days"?: number,"pricing_model"?: string,"start_date"?: string | null,"status"?: string,"updated_at"?: string,"white_label_reports"?: boolean
                  }
                  Relationships: [
                    {
      foreignKeyName: "agency_partners_account_manager_id_fkey"
      columns: ["account_manager_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agency_partners_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"attachments": {
                  Row: {
                    "campaign_id": string | null,"client_id": string | null,"created_at": string,"entity_id": string,"entity_type": string,"file_name": string,"id": string,"mime": string,"organization_id": string,"size_bytes": number,"storage_path": string,"uploaded_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "campaign_id"?: string | null,"client_id"?: string | null,"created_at"?: string,"entity_id": string,"entity_type": string,"file_name": string,"id"?: string,"mime": string,"organization_id": string,"size_bytes"?: number,"storage_path": string,"uploaded_by"?: string | null
                  }
                  Update: {
                    "campaign_id"?: string | null,"client_id"?: string | null,"created_at"?: string,"entity_id"?: string,"entity_type"?: string,"file_name"?: string,"id"?: string,"mime"?: string,"organization_id"?: string,"size_bytes"?: number,"storage_path"?: string,"uploaded_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "attachments_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "attachments_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "v_campaign_progress"
      referencedColumns: ["campaign_id"]
    },{
      foreignKeyName: "attachments_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "attachments_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "attachments_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"campaign_assignments": {
                  Row: {
                    "campaign_id": string,"created_at": string,"id": string,"organization_id": string,"profile_id": string,"role_on_campaign": string
                  }
                  ComputedFields: never
                  Insert: {
                    "campaign_id": string,"created_at"?: string,"id"?: string,"organization_id": string,"profile_id": string,"role_on_campaign"?: string
                  }
                  Update: {
                    "campaign_id"?: string,"created_at"?: string,"id"?: string,"organization_id"?: string,"profile_id"?: string,"role_on_campaign"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "campaign_assignments_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "campaign_assignments_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "v_campaign_progress"
      referencedColumns: ["campaign_id"]
    },{
      foreignKeyName: "campaign_assignments_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "campaign_assignments_profile_id_fkey"
      columns: ["profile_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"campaign_monthly_targets": {
                  Row: {
                    "campaign_id": string,"created_at": string,"id": string,"organization_id": string,"period_month": string,"target_cost": number | null,"target_links": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "campaign_id": string,"created_at"?: string,"id"?: string,"organization_id": string,"period_month": string,"target_cost"?: number | null,"target_links"?: number,"updated_at"?: string
                  }
                  Update: {
                    "campaign_id"?: string,"created_at"?: string,"id"?: string,"organization_id"?: string,"period_month"?: string,"target_cost"?: number | null,"target_links"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "campaign_monthly_targets_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "campaign_monthly_targets_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "v_campaign_progress"
      referencedColumns: ["campaign_id"]
    },{
      foreignKeyName: "campaign_monthly_targets_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"campaigns": {
                  Row: {
                    "anchor_mix": NonNullable<Json>,"client_id": string,"created_at": string,"deleted_at": string | null,"end_date": string | null,"id": string,"monthly_link_target": number,"name": string,"organization_id": string,"service_type": string,"start_date": string | null,"status": string,"target_dr_min": number | null,"target_traffic_min": number | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "anchor_mix"?: NonNullable<Json>,"client_id": string,"created_at"?: string,"deleted_at"?: string | null,"end_date"?: string | null,"id"?: string,"monthly_link_target"?: number,"name": string,"organization_id": string,"service_type"?: string,"start_date"?: string | null,"status"?: string,"target_dr_min"?: number | null,"target_traffic_min"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "anchor_mix"?: NonNullable<Json>,"client_id"?: string,"created_at"?: string,"deleted_at"?: string | null,"end_date"?: string | null,"id"?: string,"monthly_link_target"?: number,"name"?: string,"organization_id"?: string,"service_type"?: string,"start_date"?: string | null,"status"?: string,"target_dr_min"?: number | null,"target_traffic_min"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "campaigns_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "campaigns_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"client_billing_profiles": {
                  Row: {
                    "billing_address": NonNullable<Json>,"billing_currency": string,"client_id": string,"created_at": string,"id": string,"legal_name": string | null,"organization_id": string,"payment_terms_days": number,"tax_id": string | null,"tax_rate": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "billing_address"?: NonNullable<Json>,"billing_currency"?: string,"client_id": string,"created_at"?: string,"id"?: string,"legal_name"?: string | null,"organization_id": string,"payment_terms_days"?: number,"tax_id"?: string | null,"tax_rate"?: number,"updated_at"?: string
                  }
                  Update: {
                    "billing_address"?: NonNullable<Json>,"billing_currency"?: string,"client_id"?: string,"created_at"?: string,"id"?: string,"legal_name"?: string | null,"organization_id"?: string,"payment_terms_days"?: number,"tax_id"?: string | null,"tax_rate"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "client_billing_profiles_client_id_fkey"
      columns: ["client_id"]
isOneToOne: true
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "client_billing_profiles_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"client_contacts": {
                  Row: {
                    "client_id": string,"created_at": string,"email": string | null,"id": string,"is_primary": boolean,"name": string,"organization_id": string,"phone": string | null,"role_title": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "client_id": string,"created_at"?: string,"email"?: string | null,"id"?: string,"is_primary"?: boolean,"name": string,"organization_id": string,"phone"?: string | null,"role_title"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "client_id"?: string,"created_at"?: string,"email"?: string | null,"id"?: string,"is_primary"?: boolean,"name"?: string,"organization_id"?: string,"phone"?: string | null,"role_title"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "client_contacts_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "client_contacts_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"client_contracts": {
                  Row: {
                    "billing_cycle": string,"client_id": string,"created_at": string,"currency": string,"end_date": string | null,"id": string,"organization_id": string,"retainer_amount": number,"start_date": string,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "billing_cycle"?: string,"client_id": string,"created_at"?: string,"currency"?: string,"end_date"?: string | null,"id"?: string,"organization_id": string,"retainer_amount"?: number,"start_date"?: string,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "billing_cycle"?: string,"client_id"?: string,"created_at"?: string,"currency"?: string,"end_date"?: string | null,"id"?: string,"organization_id"?: string,"retainer_amount"?: number,"start_date"?: string,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "client_contracts_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "client_contracts_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"clients": {
                  Row: {
                    "agency_partner_id": string | null,"created_at": string,"deleted_at": string | null,"domain": string,"id": string,"industry": string | null,"manager_id": string | null,"name": string,"notes": string | null,"organization_id": string,"start_date": string | null,"status": string,"updated_at": string,"website_url": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "agency_partner_id"?: string | null,"created_at"?: string,"deleted_at"?: string | null,"domain": string,"id"?: string,"industry"?: string | null,"manager_id"?: string | null,"name": string,"notes"?: string | null,"organization_id": string,"start_date"?: string | null,"status"?: string,"updated_at"?: string,"website_url"?: string | null
                  }
                  Update: {
                    "agency_partner_id"?: string | null,"created_at"?: string,"deleted_at"?: string | null,"domain"?: string,"id"?: string,"industry"?: string | null,"manager_id"?: string | null,"name"?: string,"notes"?: string | null,"organization_id"?: string,"start_date"?: string | null,"status"?: string,"updated_at"?: string,"website_url"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "clients_agency_partner_id_fkey"
      columns: ["agency_partner_id"]
isOneToOne: false
      referencedRelation: "agency_partners"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "clients_manager_id_fkey"
      columns: ["manager_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "clients_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"content_briefs": {
                  Row: {
                    "assigned_to": string | null,"brief": string | null,"created_at": string,"draft_url": string | null,"due_date": string | null,"id": string,"organization_id": string,"placement_id": string,"revision_notes": string | null,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assigned_to"?: string | null,"brief"?: string | null,"created_at"?: string,"draft_url"?: string | null,"due_date"?: string | null,"id"?: string,"organization_id": string,"placement_id": string,"revision_notes"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "assigned_to"?: string | null,"brief"?: string | null,"created_at"?: string,"draft_url"?: string | null,"due_date"?: string | null,"id"?: string,"organization_id"?: string,"placement_id"?: string,"revision_notes"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "content_briefs_assigned_to_fkey"
      columns: ["assigned_to"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "content_briefs_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "content_briefs_placement_id_fkey"
      columns: ["placement_id"]
isOneToOne: false
      referencedRelation: "placements"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "content_briefs_placement_id_fkey"
      columns: ["placement_id"]
isOneToOne: false
      referencedRelation: "v_placement_margin"
      referencedColumns: ["placement_id"]
    }
                  ]
                },"custom_field_definitions": {
                  Row: {
                    "created_at": string,"entity_type": string,"field_type": string,"id": string,"is_required": boolean,"key": string,"label": string,"options": NonNullable<Json>,"organization_id": string,"sort_order": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"entity_type": string,"field_type": string,"id"?: string,"is_required"?: boolean,"key": string,"label": string,"options"?: NonNullable<Json>,"organization_id": string,"sort_order"?: number
                  }
                  Update: {
                    "created_at"?: string,"entity_type"?: string,"field_type"?: string,"id"?: string,"is_required"?: boolean,"key"?: string,"label"?: string,"options"?: NonNullable<Json>,"organization_id"?: string,"sort_order"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "custom_field_definitions_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"custom_field_values": {
                  Row: {
                    "campaign_id": string | null,"client_id": string | null,"created_at": string,"definition_id": string,"entity_id": string,"id": string,"organization_id": string,"updated_at": string,"value_bool": boolean | null,"value_date": string | null,"value_jsonb": Json | null,"value_number": number | null,"value_text": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "campaign_id"?: string | null,"client_id"?: string | null,"created_at"?: string,"definition_id": string,"entity_id": string,"id"?: string,"organization_id": string,"updated_at"?: string,"value_bool"?: boolean | null,"value_date"?: string | null,"value_jsonb"?: Json | null,"value_number"?: number | null,"value_text"?: string | null
                  }
                  Update: {
                    "campaign_id"?: string | null,"client_id"?: string | null,"created_at"?: string,"definition_id"?: string,"entity_id"?: string,"id"?: string,"organization_id"?: string,"updated_at"?: string,"value_bool"?: boolean | null,"value_date"?: string | null,"value_jsonb"?: Json | null,"value_number"?: number | null,"value_text"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "custom_field_values_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "custom_field_values_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "v_campaign_progress"
      referencedColumns: ["campaign_id"]
    },{
      foreignKeyName: "custom_field_values_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "custom_field_values_definition_id_fkey"
      columns: ["definition_id"]
isOneToOne: false
      referencedRelation: "custom_field_definitions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "custom_field_values_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"document_sequences": {
                  Row: {
                    "doc_type": string,"next_number": number,"organization_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "doc_type": string,"next_number"?: number,"organization_id": string
                  }
                  Update: {
                    "doc_type"?: string,"next_number"?: number,"organization_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "document_sequences_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"email_outbox": {
                  Row: {
                    "created_at": string,"error": string | null,"id": string,"organization_id": string,"payload": NonNullable<Json>,"prospect_id": string | null,"provider_message_id": string | null,"status": string,"template_id": string | null,"to_email": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"error"?: string | null,"id"?: string,"organization_id": string,"payload"?: NonNullable<Json>,"prospect_id"?: string | null,"provider_message_id"?: string | null,"status"?: string,"template_id"?: string | null,"to_email": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"error"?: string | null,"id"?: string,"organization_id"?: string,"payload"?: NonNullable<Json>,"prospect_id"?: string | null,"provider_message_id"?: string | null,"status"?: string,"template_id"?: string | null,"to_email"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "email_outbox_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "email_outbox_prospect_id_fkey"
      columns: ["prospect_id"]
isOneToOne: false
      referencedRelation: "prospects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "email_outbox_template_id_fkey"
      columns: ["template_id"]
isOneToOne: false
      referencedRelation: "email_templates"
      referencedColumns: ["id"]
    }
                  ]
                },"email_templates": {
                  Row: {
                    "body_md": string,"category": string,"created_at": string,"id": string,"name": string,"organization_id": string,"subject": string,"updated_at": string,"variables": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "body_md": string,"category"?: string,"created_at"?: string,"id"?: string,"name": string,"organization_id": string,"subject": string,"updated_at"?: string,"variables"?: NonNullable<Json>
                  }
                  Update: {
                    "body_md"?: string,"category"?: string,"created_at"?: string,"id"?: string,"name"?: string,"organization_id"?: string,"subject"?: string,"updated_at"?: string,"variables"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "email_templates_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"export_jobs": {
                  Row: {
                    "created_at": string,"entity": string,"error": string | null,"filters": NonNullable<Json>,"format": string,"id": string,"organization_id": string,"requested_by": string,"row_count": number | null,"status": string,"storage_path": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"entity": string,"error"?: string | null,"filters"?: NonNullable<Json>,"format"?: string,"id"?: string,"organization_id": string,"requested_by": string,"row_count"?: number | null,"status"?: string,"storage_path"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"entity"?: string,"error"?: string | null,"filters"?: NonNullable<Json>,"format"?: string,"id"?: string,"organization_id"?: string,"requested_by"?: string,"row_count"?: number | null,"status"?: string,"storage_path"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "export_jobs_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "export_jobs_requested_by_fkey"
      columns: ["requested_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"import_jobs": {
                  Row: {
                    "committed_at": string | null,"created_at": string,"created_by": string | null,"entity": string,"file_name": string | null,"id": string,"organization_id": string,"results": NonNullable<Json>,"rows": NonNullable<Json>,"status": string,"summary": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "committed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"entity": string,"file_name"?: string | null,"id"?: string,"organization_id": string,"results"?: NonNullable<Json>,"rows"?: NonNullable<Json>,"status"?: string,"summary"?: NonNullable<Json>
                  }
                  Update: {
                    "committed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"entity"?: string,"file_name"?: string | null,"id"?: string,"organization_id"?: string,"results"?: NonNullable<Json>,"rows"?: NonNullable<Json>,"status"?: string,"summary"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_jobs_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "import_jobs_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"invitations": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"created_at": string,"email": string,"expires_at": string,"full_name": string,"id": string,"invited_by": string | null,"organization_id": string,"role": string,"status": string,"supplier_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"email": string,"expires_at"?: string,"full_name": string,"id"?: string,"invited_by"?: string | null,"organization_id": string,"role": string,"status"?: string,"supplier_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"email"?: string,"expires_at"?: string,"full_name"?: string,"id"?: string,"invited_by"?: string | null,"organization_id"?: string,"role"?: string,"status"?: string,"supplier_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "invitations_accepted_by_fkey"
      columns: ["accepted_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invitations_invited_by_fkey"
      columns: ["invited_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invitations_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invitations_supplier_id_fkey"
      columns: ["supplier_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["id"]
    }
                  ]
                },"invoice_line_items": {
                  Row: {
                    "amount": number | null,"created_at": string,"description": string,"id": string,"invoice_id": string,"organization_id": string,"placement_id": string | null,"quantity": number,"sort_order": number,"unit_price": number
                  }
                  ComputedFields: never
                  Insert: {
                    "amount"?: never,"created_at"?: string,"description": string,"id"?: string,"invoice_id": string,"organization_id": string,"placement_id"?: string | null,"quantity"?: number,"sort_order"?: number,"unit_price"?: number
                  }
                  Update: {
                    "amount"?: never,"created_at"?: string,"description"?: string,"id"?: string,"invoice_id"?: string,"organization_id"?: string,"placement_id"?: string | null,"quantity"?: number,"sort_order"?: number,"unit_price"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "invoice_line_items_invoice_id_fkey"
      columns: ["invoice_id"]
isOneToOne: false
      referencedRelation: "invoices"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invoice_line_items_invoice_id_fkey"
      columns: ["invoice_id"]
isOneToOne: false
      referencedRelation: "v_ar_aging"
      referencedColumns: ["invoice_id"]
    },{
      foreignKeyName: "invoice_line_items_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invoice_line_items_placement_id_fkey"
      columns: ["placement_id"]
isOneToOne: false
      referencedRelation: "placements"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invoice_line_items_placement_id_fkey"
      columns: ["placement_id"]
isOneToOne: false
      referencedRelation: "v_placement_margin"
      referencedColumns: ["placement_id"]
    }
                  ]
                },"invoices": {
                  Row: {
                    "client_id": string,"created_at": string,"currency": string,"due_date": string | null,"id": string,"invoice_number": string,"issued_at": string | null,"notes": string | null,"organization_id": string,"pdf_path": string | null,"period_end": string,"period_start": string,"status": string,"subtotal": number,"tax_amount": number,"tax_rate": number,"total": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "client_id": string,"created_at"?: string,"currency"?: string,"due_date"?: string | null,"id"?: string,"invoice_number": string,"issued_at"?: string | null,"notes"?: string | null,"organization_id": string,"pdf_path"?: string | null,"period_end": string,"period_start": string,"status"?: string,"subtotal"?: number,"tax_amount"?: number,"tax_rate"?: number,"total"?: number,"updated_at"?: string
                  }
                  Update: {
                    "client_id"?: string,"created_at"?: string,"currency"?: string,"due_date"?: string | null,"id"?: string,"invoice_number"?: string,"issued_at"?: string | null,"notes"?: string | null,"organization_id"?: string,"pdf_path"?: string | null,"period_end"?: string,"period_start"?: string,"status"?: string,"subtotal"?: number,"tax_amount"?: number,"tax_rate"?: number,"total"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "invoices_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invoices_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"job_runs": {
                  Row: {
                    "detail": NonNullable<Json>,"finished_at": string | null,"id": string,"job_name": string,"organization_id": string | null,"started_at": string,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "detail"?: NonNullable<Json>,"finished_at"?: string | null,"id"?: string,"job_name": string,"organization_id"?: string | null,"started_at"?: string,"status"?: string
                  }
                  Update: {
                    "detail"?: NonNullable<Json>,"finished_at"?: string | null,"id"?: string,"job_name"?: string,"organization_id"?: string | null,"started_at"?: string,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "job_runs_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"link_checks": {
                  Row: {
                    "checked_at": string,"checked_by": string,"found": boolean,"http_status": number | null,"id": string,"index_status": string | null,"organization_id": string,"placement_id": string,"raw": NonNullable<Json>,"rel_attribute": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "checked_at"?: string,"checked_by"?: string,"found"?: boolean,"http_status"?: number | null,"id"?: string,"index_status"?: string | null,"organization_id": string,"placement_id": string,"raw"?: NonNullable<Json>,"rel_attribute"?: string | null
                  }
                  Update: {
                    "checked_at"?: string,"checked_by"?: string,"found"?: boolean,"http_status"?: number | null,"id"?: string,"index_status"?: string | null,"organization_id"?: string,"placement_id"?: string,"raw"?: NonNullable<Json>,"rel_attribute"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "link_checks_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "link_checks_placement_id_fkey"
      columns: ["placement_id"]
isOneToOne: false
      referencedRelation: "placements"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "link_checks_placement_id_fkey"
      columns: ["placement_id"]
isOneToOne: false
      referencedRelation: "v_placement_margin"
      referencedColumns: ["placement_id"]
    }
                  ]
                },"notifications": {
                  Row: {
                    "created_at": string,"id": string,"organization_id": string,"payload": NonNullable<Json>,"read_at": string | null,"type": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"organization_id": string,"payload"?: NonNullable<Json>,"read_at"?: string | null,"type": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"organization_id"?: string,"payload"?: NonNullable<Json>,"read_at"?: string | null,"type"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notifications_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notifications_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"organizations": {
                  Row: {
                    "brand_color": string | null,"created_at": string,"currency": string,"id": string,"invoice_prefix": string,"logo_url": string | null,"name": string,"settings": NonNullable<Json>,"slug": string,"timezone": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "brand_color"?: string | null,"created_at"?: string,"currency"?: string,"id"?: string,"invoice_prefix"?: string,"logo_url"?: string | null,"name": string,"settings"?: NonNullable<Json>,"slug": string,"timezone"?: string,"updated_at"?: string
                  }
                  Update: {
                    "brand_color"?: string | null,"created_at"?: string,"currency"?: string,"id"?: string,"invoice_prefix"?: string,"logo_url"?: string | null,"name"?: string,"settings"?: NonNullable<Json>,"slug"?: string,"timezone"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"outreach_touchpoints": {
                  Row: {
                    "body_excerpt": string | null,"channel": string,"created_at": string,"direction": string,"id": string,"message_id": string | null,"occurred_at": string,"organization_id": string,"outcome": string | null,"prospect_id": string,"subject": string | null,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "body_excerpt"?: string | null,"channel": string,"created_at"?: string,"direction": string,"id"?: string,"message_id"?: string | null,"occurred_at"?: string,"organization_id": string,"outcome"?: string | null,"prospect_id": string,"subject"?: string | null,"user_id"?: string | null
                  }
                  Update: {
                    "body_excerpt"?: string | null,"channel"?: string,"created_at"?: string,"direction"?: string,"id"?: string,"message_id"?: string | null,"occurred_at"?: string,"organization_id"?: string,"outcome"?: string | null,"prospect_id"?: string,"subject"?: string | null,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_touchpoints_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "outreach_touchpoints_prospect_id_fkey"
      columns: ["prospect_id"]
isOneToOne: false
      referencedRelation: "prospects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "outreach_touchpoints_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"payments": {
                  Row: {
                    "amount": number,"created_at": string,"currency": string,"id": string,"invoice_id": string,"method": string,"organization_id": string,"received_at": string,"recorded_by": string | null,"reference": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"created_at"?: string,"currency"?: string,"id"?: string,"invoice_id": string,"method"?: string,"organization_id": string,"received_at"?: string,"recorded_by"?: string | null,"reference"?: string | null
                  }
                  Update: {
                    "amount"?: number,"created_at"?: string,"currency"?: string,"id"?: string,"invoice_id"?: string,"method"?: string,"organization_id"?: string,"received_at"?: string,"recorded_by"?: string | null,"reference"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "payments_invoice_id_fkey"
      columns: ["invoice_id"]
isOneToOne: false
      referencedRelation: "invoices"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "payments_invoice_id_fkey"
      columns: ["invoice_id"]
isOneToOne: false
      referencedRelation: "v_ar_aging"
      referencedColumns: ["invoice_id"]
    },{
      foreignKeyName: "payments_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "payments_recorded_by_fkey"
      columns: ["recorded_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"pipeline_stages": {
                  Row: {
                    "created_at": string,"id": string,"is_lost": boolean,"is_won": boolean,"key": string,"label": string,"organization_id": string,"sort_order": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_lost"?: boolean,"is_won"?: boolean,"key": string,"label": string,"organization_id": string,"sort_order"?: number,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_lost"?: boolean,"is_won"?: boolean,"key"?: string,"label"?: string,"organization_id"?: string,"sort_order"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "pipeline_stages_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"placement_costs": {
                  Row: {
                    "created_at": string,"currency": string,"id": string,"organization_id": string,"paid": boolean,"placement_id": string,"supplier_cost": number,"supplier_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"currency"?: string,"id"?: string,"organization_id": string,"paid"?: boolean,"placement_id": string,"supplier_cost"?: number,"supplier_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"currency"?: string,"id"?: string,"organization_id"?: string,"paid"?: boolean,"placement_id"?: string,"supplier_cost"?: number,"supplier_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "placement_costs_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "placement_costs_placement_id_fkey"
      columns: ["placement_id"]
isOneToOne: true
      referencedRelation: "placements"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "placement_costs_placement_id_fkey"
      columns: ["placement_id"]
isOneToOne: true
      referencedRelation: "v_placement_margin"
      referencedColumns: ["placement_id"]
    },{
      foreignKeyName: "placement_costs_supplier_id_fkey"
      columns: ["supplier_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["id"]
    }
                  ]
                },"placement_pricing": {
                  Row: {
                    "billed": boolean,"client_rate": number,"created_at": string,"currency": string,"id": string,"organization_id": string,"placement_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "billed"?: boolean,"client_rate"?: number,"created_at"?: string,"currency"?: string,"id"?: string,"organization_id": string,"placement_id": string,"updated_at"?: string
                  }
                  Update: {
                    "billed"?: boolean,"client_rate"?: number,"created_at"?: string,"currency"?: string,"id"?: string,"organization_id"?: string,"placement_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "placement_pricing_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "placement_pricing_placement_id_fkey"
      columns: ["placement_id"]
isOneToOne: true
      referencedRelation: "placements"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "placement_pricing_placement_id_fkey"
      columns: ["placement_id"]
isOneToOne: true
      referencedRelation: "v_placement_margin"
      referencedColumns: ["placement_id"]
    }
                  ]
                },"placements": {
                  Row: {
                    "anchor_text": string | null,"anchor_type": string | null,"campaign_id": string,"created_at": string,"deleted_at": string | null,"id": string,"index_status": string,"index_status_manual": boolean,"last_checked_at": string | null,"link_type": string | null,"live_date": string | null,"live_url": string | null,"notes": string | null,"organization_id": string,"prospect_id": string | null,"publisher_id": string | null,"rel_attribute": string | null,"removal_detected_at": string | null,"scheduled_date": string | null,"status": string,"supplier_id": string | null,"target_url": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "anchor_text"?: string | null,"anchor_type"?: string | null,"campaign_id": string,"created_at"?: string,"deleted_at"?: string | null,"id"?: string,"index_status"?: string,"index_status_manual"?: boolean,"last_checked_at"?: string | null,"link_type"?: string | null,"live_date"?: string | null,"live_url"?: string | null,"notes"?: string | null,"organization_id": string,"prospect_id"?: string | null,"publisher_id"?: string | null,"rel_attribute"?: string | null,"removal_detected_at"?: string | null,"scheduled_date"?: string | null,"status"?: string,"supplier_id"?: string | null,"target_url": string,"updated_at"?: string
                  }
                  Update: {
                    "anchor_text"?: string | null,"anchor_type"?: string | null,"campaign_id"?: string,"created_at"?: string,"deleted_at"?: string | null,"id"?: string,"index_status"?: string,"index_status_manual"?: boolean,"last_checked_at"?: string | null,"link_type"?: string | null,"live_date"?: string | null,"live_url"?: string | null,"notes"?: string | null,"organization_id"?: string,"prospect_id"?: string | null,"publisher_id"?: string | null,"rel_attribute"?: string | null,"removal_detected_at"?: string | null,"scheduled_date"?: string | null,"status"?: string,"supplier_id"?: string | null,"target_url"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "placements_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "placements_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "v_campaign_progress"
      referencedColumns: ["campaign_id"]
    },{
      foreignKeyName: "placements_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "placements_prospect_id_fkey"
      columns: ["prospect_id"]
isOneToOne: false
      referencedRelation: "prospects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "placements_publisher_id_fkey"
      columns: ["publisher_id"]
isOneToOne: false
      referencedRelation: "publishers"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "placements_supplier_id_fkey"
      columns: ["supplier_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "avatar_url": string | null,"created_at": string,"email": string,"full_name": string,"id": string,"invited_by": string | null,"is_active": boolean,"last_seen_at": string | null,"organization_id": string,"phone": string | null,"role": string,"role_changed_at": string,"supplier_id": string | null,"suspended_at": string | null,"suspended_by": string | null,"suspension_reason": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "avatar_url"?: string | null,"created_at"?: string,"email": string,"full_name": string,"id": string,"invited_by"?: string | null,"is_active"?: boolean,"last_seen_at"?: string | null,"organization_id": string,"phone"?: string | null,"role": string,"role_changed_at"?: string,"supplier_id"?: string | null,"suspended_at"?: string | null,"suspended_by"?: string | null,"suspension_reason"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "avatar_url"?: string | null,"created_at"?: string,"email"?: string,"full_name"?: string,"id"?: string,"invited_by"?: string | null,"is_active"?: boolean,"last_seen_at"?: string | null,"organization_id"?: string,"phone"?: string | null,"role"?: string,"role_changed_at"?: string,"supplier_id"?: string | null,"suspended_at"?: string | null,"suspended_by"?: string | null,"suspension_reason"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "profiles_invited_by_fkey"
      columns: ["invited_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "profiles_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "profiles_supplier_id_fkey"
      columns: ["supplier_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "profiles_suspended_by_fkey"
      columns: ["suspended_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"prospects": {
                  Row: {
                    "assigned_to": string | null,"campaign_id": string,"contact_email": string | null,"contact_name": string | null,"contact_name_2": string | null,"created_at": string,"currency": string,"deleted_at": string | null,"domain": string,"dr": number | null,"id": string,"last_contacted_at": string | null,"monthly_traffic": number | null,"next_follow_up_at": string | null,"niche": (string)[],"notes": string | null,"organization_id": string,"price": number | null,"priority": string,"publisher_id": string | null,"reply_received": boolean,"spam_score": number | null,"stage": string,"supplier_id": string | null,"updated_at": string,"website_url": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "assigned_to"?: string | null,"campaign_id": string,"contact_email"?: string | null,"contact_name"?: string | null,"contact_name_2"?: string | null,"created_at"?: string,"currency"?: string,"deleted_at"?: string | null,"domain": string,"dr"?: number | null,"id"?: string,"last_contacted_at"?: string | null,"monthly_traffic"?: number | null,"next_follow_up_at"?: string | null,"niche"?: (string)[],"notes"?: string | null,"organization_id": string,"price"?: number | null,"priority"?: string,"publisher_id"?: string | null,"reply_received"?: boolean,"spam_score"?: number | null,"stage"?: string,"supplier_id"?: string | null,"updated_at"?: string,"website_url"?: string | null
                  }
                  Update: {
                    "assigned_to"?: string | null,"campaign_id"?: string,"contact_email"?: string | null,"contact_name"?: string | null,"contact_name_2"?: string | null,"created_at"?: string,"currency"?: string,"deleted_at"?: string | null,"domain"?: string,"dr"?: number | null,"id"?: string,"last_contacted_at"?: string | null,"monthly_traffic"?: number | null,"next_follow_up_at"?: string | null,"niche"?: (string)[],"notes"?: string | null,"organization_id"?: string,"price"?: number | null,"priority"?: string,"publisher_id"?: string | null,"reply_received"?: boolean,"spam_score"?: number | null,"stage"?: string,"supplier_id"?: string | null,"updated_at"?: string,"website_url"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "prospects_assigned_to_fkey"
      columns: ["assigned_to"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "prospects_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "prospects_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "v_campaign_progress"
      referencedColumns: ["campaign_id"]
    },{
      foreignKeyName: "prospects_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "prospects_publisher_id_fkey"
      columns: ["publisher_id"]
isOneToOne: false
      referencedRelation: "publishers"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "prospects_supplier_id_fkey"
      columns: ["supplier_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["id"]
    }
                  ]
                },"publisher_offers": {
                  Row: {
                    "created_at": string,"currency": string,"id": string,"link_type": string,"organization_id": string,"publisher_id": string,"quoted_price": number,"source": string | null,"updated_at": string,"valid_from": string,"valid_until": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"currency"?: string,"id"?: string,"link_type"?: string,"organization_id": string,"publisher_id": string,"quoted_price": number,"source"?: string | null,"updated_at"?: string,"valid_from"?: string,"valid_until"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"currency"?: string,"id"?: string,"link_type"?: string,"organization_id"?: string,"publisher_id"?: string,"quoted_price"?: number,"source"?: string | null,"updated_at"?: string,"valid_from"?: string,"valid_until"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "publisher_offers_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "publisher_offers_publisher_id_fkey"
      columns: ["publisher_id"]
isOneToOne: false
      referencedRelation: "publishers"
      referencedColumns: ["id"]
    }
                  ]
                },"publishers": {
                  Row: {
                    "accepts_guest_post": boolean | null,"accepts_link_insertion": boolean | null,"contact_email": string | null,"contact_form_url": string | null,"contact_name": string | null,"country": string | null,"created_at": string,"currency": string,"da": number | null,"deleted_at": string | null,"domain": string,"dr": number | null,"id": string,"language": string | null,"last_checked_at": string | null,"link_type": string | null,"metrics_source": string | null,"monthly_traffic": number | null,"name": string | null,"niche": (string)[],"notes": string | null,"organization_id": string,"price": number | null,"spam_score": number | null,"spam_source": string | null,"status": string,"supplier_id": string | null,"updated_at": string,"website_url": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "accepts_guest_post"?: boolean | null,"accepts_link_insertion"?: boolean | null,"contact_email"?: string | null,"contact_form_url"?: string | null,"contact_name"?: string | null,"country"?: string | null,"created_at"?: string,"currency"?: string,"da"?: number | null,"deleted_at"?: string | null,"domain": string,"dr"?: number | null,"id"?: string,"language"?: string | null,"last_checked_at"?: string | null,"link_type"?: string | null,"metrics_source"?: string | null,"monthly_traffic"?: number | null,"name"?: string | null,"niche"?: (string)[],"notes"?: string | null,"organization_id": string,"price"?: number | null,"spam_score"?: number | null,"spam_source"?: string | null,"status"?: string,"supplier_id"?: string | null,"updated_at"?: string,"website_url"?: string | null
                  }
                  Update: {
                    "accepts_guest_post"?: boolean | null,"accepts_link_insertion"?: boolean | null,"contact_email"?: string | null,"contact_form_url"?: string | null,"contact_name"?: string | null,"country"?: string | null,"created_at"?: string,"currency"?: string,"da"?: number | null,"deleted_at"?: string | null,"domain"?: string,"dr"?: number | null,"id"?: string,"language"?: string | null,"last_checked_at"?: string | null,"link_type"?: string | null,"metrics_source"?: string | null,"monthly_traffic"?: number | null,"name"?: string | null,"niche"?: (string)[],"notes"?: string | null,"organization_id"?: string,"price"?: number | null,"spam_score"?: number | null,"spam_source"?: string | null,"status"?: string,"supplier_id"?: string | null,"updated_at"?: string,"website_url"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "publishers_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "publishers_supplier_id_fkey"
      columns: ["supplier_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["id"]
    }
                  ]
                },"saved_views": {
                  Row: {
                    "created_at": string,"filters": NonNullable<Json>,"id": string,"is_shared": boolean,"module": string,"name": string,"organization_id": string,"sort": NonNullable<Json>,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"filters"?: NonNullable<Json>,"id"?: string,"is_shared"?: boolean,"module": string,"name": string,"organization_id": string,"sort"?: NonNullable<Json>,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"filters"?: NonNullable<Json>,"id"?: string,"is_shared"?: boolean,"module"?: string,"name"?: string,"organization_id"?: string,"sort"?: NonNullable<Json>,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "saved_views_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "saved_views_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"supplier_bills": {
                  Row: {
                    "amount": number,"bill_number": string | null,"created_at": string,"currency": string,"due_date": string | null,"id": string,"organization_id": string,"placement_id": string | null,"status": string,"supplier_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"bill_number"?: string | null,"created_at"?: string,"currency"?: string,"due_date"?: string | null,"id"?: string,"organization_id": string,"placement_id"?: string | null,"status"?: string,"supplier_id": string,"updated_at"?: string
                  }
                  Update: {
                    "amount"?: number,"bill_number"?: string | null,"created_at"?: string,"currency"?: string,"due_date"?: string | null,"id"?: string,"organization_id"?: string,"placement_id"?: string | null,"status"?: string,"supplier_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "supplier_bills_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "supplier_bills_placement_id_fkey"
      columns: ["placement_id"]
isOneToOne: false
      referencedRelation: "placements"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "supplier_bills_placement_id_fkey"
      columns: ["placement_id"]
isOneToOne: false
      referencedRelation: "v_placement_margin"
      referencedColumns: ["placement_id"]
    },{
      foreignKeyName: "supplier_bills_supplier_id_fkey"
      columns: ["supplier_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["id"]
    }
                  ]
                },"suppliers": {
                  Row: {
                    "contact_email": string | null,"contact_name": string | null,"created_at": string,"id": string,"name": string,"notes": string | null,"organization_id": string,"payment_terms_days": number,"status": string,"supplier_type": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "contact_email"?: string | null,"contact_name"?: string | null,"created_at"?: string,"id"?: string,"name": string,"notes"?: string | null,"organization_id": string,"payment_terms_days"?: number,"status"?: string,"supplier_type": string,"updated_at"?: string
                  }
                  Update: {
                    "contact_email"?: string | null,"contact_name"?: string | null,"created_at"?: string,"id"?: string,"name"?: string,"notes"?: string | null,"organization_id"?: string,"payment_terms_days"?: number,"status"?: string,"supplier_type"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "suppliers_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"user_client_access": {
                  Row: {
                    "client_id": string,"created_at": string,"organization_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "client_id": string,"created_at"?: string,"organization_id": string,"user_id": string
                  }
                  Update: {
                    "client_id"?: string,"created_at"?: string,"organization_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "user_client_access_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "user_client_access_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "user_client_access_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            "v_anchor_distribution": {
                  Row: {
                    "anchor_type": string | null,"campaign_id": string,"client_id": string,"link_count": number | null,"organization_id": string,"share": number | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "campaigns_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "placements_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "placements_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "v_campaign_progress"
      referencedColumns: ["campaign_id"]
    },{
      foreignKeyName: "placements_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"v_ar_aging": {
                  Row: {
                    "balance": number | null,"client_id": string,"days_overdue": number | null,"due_date": string | null,"invoice_id": string,"invoice_number": string,"organization_id": string,"paid_amount": number | null,"status": string,"total": number
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "invoices_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invoices_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"v_campaign_progress": {
                  Row: {
                    "campaign_id": string,"client_id": string,"current_month": string | null,"delivered_this_month": number | null,"monthly_link_target": number,"name": string,"organization_id": string,"target_this_month": number | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "campaigns_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "campaigns_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"v_client_profitability": {
                  Row: {
                    "billed": number | null,"client_id": string,"collected": number | null,"invoice_count": number | null,"margin": number | null,"organization_id": string,"period_month": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "invoices_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invoices_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"v_outreach_funnel": {
                  Row: {
                    "campaign_id": string,"organization_id": string,"overdue_follow_ups": number | null,"prospect_count": number | null,"replied_count": number | null,"stage": string
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "prospects_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "prospects_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "v_campaign_progress"
      referencedColumns: ["campaign_id"]
    },{
      foreignKeyName: "prospects_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"v_placement_margin": {
                  Row: {
                    "campaign_id": string,"client_id": string,"client_rate": number | null,"live_date": string | null,"margin": number | null,"margin_pct": number | null,"organization_id": string,"placement_id": string,"publisher_id": string | null,"status": string,"supplier_cost": number | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "campaigns_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "placements_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "placements_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "v_campaign_progress"
      referencedColumns: ["campaign_id"]
    },{
      foreignKeyName: "placements_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "placements_publisher_id_fkey"
      columns: ["publisher_id"]
isOneToOne: false
      referencedRelation: "publishers"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Functions: {
            "next_document_number_rpc":
{ Args: { "p_org": string,"p_type": string }; Returns: number
                           },
"show_limit":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"show_trgm":
{ Args: { "": string }; Returns: (string)[]
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const

