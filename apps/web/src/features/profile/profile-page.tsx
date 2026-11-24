import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, ShieldCheck } from "lucide-react";
import { useAccessToken, useAuth } from "@/providers/auth";
import { apiRequest, type ApiError } from "@/lib/api";
import { formatDate, humanize } from "@/lib/utils";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { PageHeading } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/card";

interface MyProfile {
  id: string;
  full_name: string;
  email: string;
  role: string;
  phone: string | null;
  avatar_url: string | null;
  is_active: boolean;
  last_seen_at: string | null;
  created_at: string;
  role_changed_at: string;
}

export function ProfilePage() {
  const token = useAccessToken();
  const { user, permissions } = useAuth();
  const queryClient = useQueryClient();

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const profile = useQuery({
    queryKey: ["profile", "me"],
    queryFn: () => apiRequest<MyProfile>("/api/v1/profile", { token }),
    enabled: Boolean(token),
  });

  useEffect(() => {
    if (profile.data?.data) {
      setFullName(profile.data.data.full_name);
      setPhone(profile.data.data.phone ?? "");
    }
  }, [profile.data]);

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<MyProfile>("/api/v1/profile", {
        method: "PATCH",
        token,
        body: { fullName, phone },
      }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
      window.setTimeout(() => setSaved(false), 4000);
    },
    onError: (err) => setError((err as ApiError)?.message ?? "Could not save your profile."),
  });

  const data = profile.data?.data;

  return (
    <PageContainer width="narrow">
      <PageStack>
        <PageHeading
          title="Your profile"
          description="Your name, contact details and role. Role and access are managed by an administrator."
        />

        {profile.isLoading ? (
          <Card className="p-6">
            <Skeleton className="mb-4 h-12 w-12 rounded-full" />
            <Skeleton className="mb-2 h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </Card>
        ) : (
          <Card>
            <CardContent className="pt-5">
              <div className="mb-5 flex items-center gap-3">
                <Avatar name={data?.full_name} email={data?.email} size="lg" />
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold text-foreground">{data?.full_name}</p>
                  <p className="truncate text-[12.5px] text-muted">{data?.email}</p>
                </div>
                <div className="ml-auto">
                  <Badge tone={data?.role === "owner" ? "brand" : "neutral"}>
                    {humanize(data?.role ?? "")}
                  </Badge>
                </div>
              </div>

              <form
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  mutation.mutate();
                }}
                className="flex flex-col gap-4"
              >
                <Field label="Full name" htmlFor="profile-name">
                  <Input
                    id="profile-name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                  />
                </Field>

                <Field label="Phone" htmlFor="profile-phone" hint="Optional.">
                  <Input
                    id="profile-phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+44 7700 900123"
                  />
                </Field>

                <Field label="Email" htmlFor="profile-email" hint="Contact an administrator to change your email.">
                  <Input id="profile-email" value={data?.email ?? ""} disabled />
                </Field>

                {error && (
                  <div role="alert" className="flex gap-2.5 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-3">
                    <AlertCircle className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" aria-hidden />
                    <p className="text-[12.5px] text-[var(--color-danger)]">{error}</p>
                  </div>
                )}

                {saved && (
                  <div role="status" className="flex gap-2.5 rounded-md border border-[var(--color-success)]/30 bg-[var(--color-success-soft)] p-3">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--color-success)]" aria-hidden />
                    <p className="text-[12.5px] text-[var(--color-success)]">Profile saved.</p>
                  </div>
                )}

                <div className="flex justify-end">
                  <Button type="submit" loading={mutation.isPending}>
                    Save changes
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-muted" aria-hidden />
              <CardTitle>Your access</CardTitle>
            </div>
            <CardDescription>
              Granted by your role. Enforced by the database on every request.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {permissions.map((permission) => (
                <Badge key={permission} tone="outline" className="font-mono text-[10.5px]">
                  {permission}
                </Badge>
              ))}
            </div>
            {data && (
              <dl className="mt-4 grid grid-cols-2 gap-3 text-[12px]">
                <div>
                  <dt className="text-muted">Member since</dt>
                  <dd className="text-foreground-soft">{formatDate(data.created_at)}</dd>
                </div>
                <div>
                  <dt className="text-muted">Role last changed</dt>
                  <dd className="text-foreground-soft">{formatDate(data.role_changed_at)}</dd>
                </div>
              </dl>
            )}
          </CardContent>
        </Card>
      </PageStack>
    </PageContainer>
  );
}
