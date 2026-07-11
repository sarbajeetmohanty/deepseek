import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

function initials(name?: string | null, email?: string | null) {
  const src = (name || email || "?").trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

export function UserAvatar({
  path,
  name,
  email,
  className,
  size = 32,
}: {
  path?: string | null;
  name?: string | null;
  email?: string | null;
  className?: string;
  size?: number;
}) {
  const { data: url } = useQuery({
    queryKey: ["avatar-url", path],
    enabled: !!path,
    staleTime: 55 * 60_000, // signed URL is valid for ~1 hour
    gcTime: 60 * 60_000,
    queryFn: async () => {
      if (!path) return null;
      const { data, error } = await supabase.storage
        .from("avatars")
        .createSignedUrl(path, 60 * 60);
      if (error) return null;
      return data.signedUrl;
    },
  });

  return (
    <Avatar
      className={cn("border border-border/50", className)}
      style={{ width: size, height: size }}
    >
      {url ? <AvatarImage src={url} alt={name || email || "avatar"} /> : null}
      <AvatarFallback className="bg-gradient-to-br from-primary/20 to-accent/40 text-[11px] font-semibold text-foreground">
        {initials(name, email)}
      </AvatarFallback>
    </Avatar>
  );
}