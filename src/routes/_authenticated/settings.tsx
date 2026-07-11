import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { UserAvatar } from "@/components/user-avatar";
import { LANGUAGES, useI18n, type Lang } from "@/lib/i18n";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
  errorComponent: SettingsError,
  notFoundComponent: () => (
    <div className="max-w-md mx-auto text-center py-16 space-y-4">
      <h2 className="text-lg font-semibold">Not found</h2>
      <Link to="/"><Button>Back to dashboard</Button></Link>
    </div>
  ),
});

function SettingsError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="max-w-md mx-auto text-center py-16 space-y-4">
      <h2 className="text-lg font-semibold">Settings failed to load</h2>
      <p className="text-sm text-muted-foreground">{error.message}</p>
      <Button onClick={() => { router.invalidate(); reset(); }}>Try again</Button>
    </div>
  );
}

function SettingsPage() {
  const { userId, email } = Route.useRouteContext();
  const qc = useQueryClient();
  const { t, lang, setLang } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [uploading, setUploading] = useState(false);

  const { data: profile } = useQuery({
    queryKey: ["profile", userId],
    enabled: !!userId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,avatar_url,email,preferred_language")
        .eq("id", userId!)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    },
  });

  // Hydrate local state from profile when it loads.
  useEffect(() => {
    if (profile?.full_name != null) setName(profile.full_name);
    if (profile?.preferred_language && profile.preferred_language !== lang) {
      setLang(profile.preferred_language as Lang);
    }
  }, [profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveName = useMutation({
    mutationFn: async (v: string) => {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: v || null })
        .eq("id", userId!);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success(t("profileUpdated"));
      qc.invalidateQueries({ queryKey: ["profile", userId] });
      qc.invalidateQueries({ queryKey: ["team"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const saveLang = useMutation({
    mutationFn: async (v: Lang) => {
      setLang(v);
      const { error } = await supabase
        .from("profiles")
        .update({ preferred_language: v })
        .eq("id", userId!);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success(t("languageUpdated"));
      qc.invalidateQueries({ queryKey: ["profile", userId] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  async function onPickFile(file: File) {
    if (!userId) return;
    if (file.size > 3 * 1024 * 1024) {
      toast.error(t("photoTooLarge"));
      return;
    }
    setUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      const path = `${userId}/avatar-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("avatars")
        .upload(path, file, { upsert: true, contentType: file.type || "image/jpeg" });
      if (upErr) throw new Error(upErr.message);

      // Best-effort: remove any prior file so storage doesn't accumulate.
      const prev = profile?.avatar_url;
      if (prev && prev !== path) {
        await supabase.storage.from("avatars").remove([prev]).catch(() => {});
      }

      const { error: dbErr } = await supabase
        .from("profiles")
        .update({ avatar_url: path })
        .eq("id", userId);
      if (dbErr) throw new Error(dbErr.message);

      toast.success(t("photoUpdated"));
      qc.invalidateQueries({ queryKey: ["profile", userId] });
      qc.invalidateQueries({ queryKey: ["team"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removePhoto() {
    if (!userId || !profile?.avatar_url) return;
    const prev = profile.avatar_url;
    const { error } = await supabase
      .from("profiles")
      .update({ avatar_url: null })
      .eq("id", userId);
    if (error) return toast.error(error.message);
    await supabase.storage.from("avatars").remove([prev]).catch(() => {});
    toast.success(t("photoRemoved"));
    qc.invalidateQueries({ queryKey: ["profile", userId] });
    qc.invalidateQueries({ queryKey: ["team"] });
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t("settings")}</h1>
        <p className="text-muted-foreground mt-1">{email}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("profile")}</CardTitle>
          <CardDescription>{t("profilePicture")} · {t("displayName")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center gap-4">
            <UserAvatar
              path={profile?.avatar_url}
              name={profile?.full_name || name}
              email={email}
              size={72}
              className="ring-2 ring-primary/10"
            />
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onPickFile(f);
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? t("saving") : t("uploadPhoto")}
              </Button>
              {profile?.avatar_url && (
                <Button type="button" size="sm" variant="ghost" onClick={removePhoto} className="text-destructive hover:text-destructive hover:bg-destructive/10">
                  {t("removePhoto")}
                </Button>
              )}
            </div>
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); saveName.mutate(name.trim()); }}
            className="space-y-2"
          >
            <Label htmlFor="displayName">{t("displayName")}</Label>
            <div className="flex gap-2">
              <Input
                id="displayName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={email}
                maxLength={80}
              />
              <Button type="submit" disabled={saveName.isPending}>{saveName.isPending ? t("saving") : t("save")}</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("language")}</CardTitle>
          <CardDescription>{t("languageDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={lang} onValueChange={(v) => saveLang.mutate(v as Lang)}>
            <SelectTrigger className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l.code} value={l.code}>
                  {l.native} <span className="text-muted-foreground">· {l.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
    </div>
  );
}