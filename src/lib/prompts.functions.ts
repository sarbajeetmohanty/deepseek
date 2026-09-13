import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "../integrations/supabase/auth-middleware";

export interface CustomPrompt {
  id: string;
  name: string;
  text: string;
  created_at: string;
}

export const getUserPrompts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d?: { userId?: string }) => d || {})
  .handler(async ({ context }) => {
    const userId = context.userId;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: setting, error } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `custom_prompts_${userId}`)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!setting) return [];

    try {
      const parsed = JSON.parse(setting.value);
      return Array.isArray(parsed) ? (parsed as CustomPrompt[]) : [];
    } catch {
      return [];
    }
  });

export const saveUserPrompt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { name: string; text: string; userId?: string }) => {
    const name = String(data?.name ?? "")
      .trim()
      .slice(0, 100);
    const text = String(data?.text ?? "")
      .trim()
      .slice(0, 5000);
    if (!name) throw new Error("Prompt name is required");
    if (!text) throw new Error("Prompt instruction text is required");
    return { name, text };
  })
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Get existing prompts
    const { data: setting } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `custom_prompts_${userId}`)
      .maybeSingle();

    let prompts: CustomPrompt[] = [];
    if (setting) {
      try {
        const parsed = JSON.parse(setting.value);
        if (Array.isArray(parsed)) prompts = parsed;
      } catch {}
    }

    if (prompts.length >= 50) {
      throw new Error("Maximum of 50 custom prompts reached. Please delete an old prompt first.");
    }

    const newPrompt: CustomPrompt = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: data.name,
      text: data.text,
      created_at: new Date().toISOString(),
    };
    prompts.push(newPrompt);

    // Save back securely scoped to context.userId
    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert({ key: `custom_prompts_${userId}`, value: JSON.stringify(prompts) });

    if (error) throw new Error(error.message);
    return newPrompt;
  });

export const deleteUserPrompt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string; userId?: string }) => {
    if (!data?.id || typeof data.id !== "string") throw new Error("Prompt ID required");
    return { id: data.id };
  })
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: setting } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `custom_prompts_${userId}`)
      .maybeSingle();

    if (!setting) return true;

    let prompts: CustomPrompt[] = [];
    try {
      const parsed = JSON.parse(setting.value);
      if (Array.isArray(parsed)) prompts = parsed;
    } catch {}

    prompts = prompts.filter((p) => p.id !== data.id);

    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert({ key: `custom_prompts_${userId}`, value: JSON.stringify(prompts) });

    if (error) throw new Error(error.message);
    return true;
  });

export const updateUserPrompt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string; name: string; text: string; userId?: string }) => {
    if (!data?.id || typeof data.id !== "string") throw new Error("Prompt ID required");
    const name = String(data?.name ?? "")
      .trim()
      .slice(0, 100);
    const text = String(data?.text ?? "")
      .trim()
      .slice(0, 5000);
    if (!name) throw new Error("Prompt name is required");
    if (!text) throw new Error("Prompt text is required");
    return { id: data.id, name, text };
  })
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: setting } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `custom_prompts_${userId}`)
      .maybeSingle();

    if (!setting) throw new Error("No prompts found");

    let prompts: CustomPrompt[] = [];
    try {
      const parsed = JSON.parse(setting.value);
      if (Array.isArray(parsed)) prompts = parsed;
    } catch {}

    const index = prompts.findIndex((p) => p.id === data.id);
    if (index === -1) throw new Error("Prompt not found");

    prompts[index] = { ...prompts[index], name: data.name, text: data.text };

    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert({ key: `custom_prompts_${userId}`, value: JSON.stringify(prompts) });

    if (error) throw new Error(error.message);
    return prompts[index];
  });
