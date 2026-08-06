import { createServerFn } from "@tanstack/react-start";

export const getUserPrompts = createServerFn({ method: "GET" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: setting, error } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `custom_prompts_${data.userId}`)
      .maybeSingle();
      
    if (error) throw new Error(error.message);
    if (!setting) return [];
    
    try {
      return JSON.parse(setting.value);
    } catch (e) {
      return [];
    }
  });

export const saveUserPrompt = createServerFn({ method: "POST" })
  .validator((d: { userId: string, name: string, text: string }) => d)
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    
    // Get existing
    const { data: setting } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `custom_prompts_${data.userId}`)
      .maybeSingle();
      
    let prompts: any[] = [];
    if (setting) {
      try { prompts = JSON.parse(setting.value); } catch(e) {}
    }
    
    const newPrompt = { id: Date.now().toString(), name: data.name, text: data.text, created_at: new Date().toISOString() };
    prompts.push(newPrompt);
    
    // Save back
    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert({ key: `custom_prompts_${data.userId}`, value: JSON.stringify(prompts) });
      
    if (error) throw new Error(error.message);
    return newPrompt;
  });

export const deleteUserPrompt = createServerFn({ method: "POST" })
  .validator((d: { id: string, userId: string }) => d)
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    
    // Get existing
    const { data: setting } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `custom_prompts_${data.userId}`)
      .maybeSingle();
      
    if (!setting) return true;
    
    let prompts: any[] = [];
    try { prompts = JSON.parse(setting.value); } catch(e) {}
    
    prompts = prompts.filter((p: any) => p.id !== data.id);
    
    // Save back
    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert({ key: `custom_prompts_${data.userId}`, value: JSON.stringify(prompts) });
      
    if (error) throw new Error(error.message);
    return true;
  });

export const updateUserPrompt = createServerFn({ method: "POST" })
  .validator((d: { id: string, userId: string, name: string, text: string }) => d)
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    
    // Get existing
    const { data: setting } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `custom_prompts_${data.userId}`)
      .maybeSingle();
      
    if (!setting) throw new Error("No prompts found");
    
    let prompts: any[] = [];
    try { prompts = JSON.parse(setting.value); } catch(e) {}
    
    const index = prompts.findIndex((p: any) => p.id === data.id);
    if (index === -1) throw new Error("Prompt not found");
    
    prompts[index] = { ...prompts[index], name: data.name, text: data.text };
    
    // Save back
    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert({ key: `custom_prompts_${data.userId}`, value: JSON.stringify(prompts) });
      
    if (error) throw new Error(error.message);
    return prompts[index];
  });
