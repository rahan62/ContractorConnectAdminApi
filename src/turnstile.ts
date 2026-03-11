export async function verifyTurnstile(token: string | null | undefined): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  const enabled = process.env.ADMIN_TURNSTILE_ENABLED !== "false";

  if (!enabled) {
    return true;
  }

  if (!secret || !token) {
    return false;
  }

  const params = new URLSearchParams();
  params.append("secret", secret);
  params.append("response", token);

  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: params,
  });

  const data = (await res.json()) as { success: boolean };

  return data.success;
}

