import { createFileRoute, Outlet, redirect, Link, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { getMyRole } from "@/lib/invitations.functions";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { UserAvatar } from "@/components/user-avatar";
import { useI18n } from "@/lib/i18n";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { userId: data.user.id, email: data.user.email };
  },
  component: Layout,
  errorComponent: ({ error }) => (
    <div className="min-h-screen flex items-center justify-center p-6 text-center">
      <div className="max-w-md space-y-3">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="text-sm text-muted-foreground">{error.message}</p>
        <a href="/" className="text-sm underline">Reload</a>
      </div>
    </div>
  ),
});

function Layout() {
  const { email, userId } = Route.useRouteContext();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [greetingKey, setGreetingKey] = useState<"goodMorning" | "goodAfternoon" | "goodEvening">("goodMorning");

  const { data: role } = useQuery({
    queryKey: ["my-role"],
    queryFn: () => getMyRole({ data: {} } as any),
    staleTime: 5 * 60 * 1000, // role rarely changes; avoid refetch storm
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const isAdmin = role?.roles.includes("admin");

  // Own profile (for header avatar).
  const { data: myProfile } = useQuery({
    queryKey: ["profile", userId],
    enabled: !!userId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id,full_name,avatar_url,email")
        .eq("id", userId!)
        .maybeSingle();
      return data;
    },
  });

  useEffect(() => {
    const h = new Date().getHours();
    setGreetingKey(h < 12 ? "goodMorning" : h < 18 ? "goodAfternoon" : "goodEvening");
  }, []);

  async function signOut() {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not sign out");
    } finally {
      navigate({ to: "/auth", replace: true });
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link to="/" className="flex items-center gap-2 group">
              <img 
                src="/favicon.svg" 
                className="h-6 w-6 transition-transform group-hover:scale-110 duration-200" 
                alt="Earthpuls Logo" 
              />
              <span className="font-semibold text-lg tracking-tight bg-gradient-to-r from-primary to-accent-foreground bg-clip-text text-transparent">
                Earthpuls
              </span>
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <Link to="/" activeProps={{ className: "bg-secondary" }} className="px-3 py-1.5 rounded-md hover:bg-secondary transition-colors">{t("dashboard")}</Link>
              {isAdmin && (
                <Link to="/admin" activeProps={{ className: "bg-secondary" }} className="px-3 py-1.5 rounded-md hover:bg-secondary transition-colors">{t("team")}</Link>
              )}
              <Link to="/settings" activeProps={{ className: "bg-secondary" }} className="px-3 py-1.5 rounded-md hover:bg-secondary transition-colors">{t("settings")}</Link>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground hidden md:inline">{t(greetingKey)}, {myProfile?.full_name || email}</span>
            {isAdmin && <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">{t("admin")}</span>}
            <Link to="/settings" aria-label={t("settings")} className="rounded-full ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              <UserAvatar path={myProfile?.avatar_url} name={myProfile?.full_name} email={email} size={32} />
            </Link>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost">{t("signOut")}</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("signOutConfirm")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {email}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{"Cancel"}</AlertDialogCancel>
                  <AlertDialogAction onClick={signOut}>{t("signOut")}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}