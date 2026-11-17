import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/client";
import {
  deviceAuthorizationClient,
  magicLinkClient,
  organizationClient,
} from "better-auth/client/plugins";

const authClient = createAuthClient({
  plugins: [
    magicLinkClient(),
    deviceAuthorizationClient(),
    organizationClient(),
    oauthProviderClient(),
  ],
});

interface Turnstile {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      size: "flexible";
      action: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  reset(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let turnstileLoading: Promise<Turnstile> | undefined;
function loadTurnstile(): Promise<Turnstile> {
  return (turnstileLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () =>
      window.turnstile
        ? resolve(window.turnstile)
        : reject(
            new Error("Verification could not load. Please reload the page."),
          );
    script.onerror = () =>
      reject(new Error("Verification could not load. Please reload the page."));
    document.head.append(script);
  }));
}

function errorMessage(error: {
  code?: string;
  message?: string;
  status?: number;
}): string {
  if (error.status === 429)
    return "Too many attempts. Please wait a minute before trying again.";
  if (error.code === "EMAIL_NOT_VERIFIED")
    return "Email not verified. Check your email for a verification link.";
  if (error.code === "INVALID_EMAIL_OR_PASSWORD")
    return "Invalid email or password.";
  return error.message || "Something went wrong. Please try again.";
}

for (const form of document.querySelectorAll<HTMLFormElement>(
  "form[data-auth]",
)) {
  const buttons = [
    ...form.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
  ];
  const message = form.querySelector<HTMLElement>("[data-auth-message]")!;
  const sitekey = form.dataset.captchaSiteKey;
  let token = "";
  let widgetId: string | undefined;
  let busy = false;
  let complete = false;
  const updateButtons = () => {
    for (const button of buttons)
      button.disabled = busy || complete || Boolean(sitekey && !token);
  };
  const showMessage = (text: string, error = false) => {
    message.textContent = text;
    message.className = `alert ${error ? "alert--error" : "alert--success"}`;
    message.setAttribute("role", error ? "alert" : "status");
    message.hidden = false;
  };

  if (sitekey) {
    void loadTurnstile()
      .then((turnstile) => {
        widgetId = turnstile.render(
          form.querySelector<HTMLElement>("[data-captcha]")!,
          {
            sitekey,
            size: "flexible",
            action: "auth",
            callback: (value) => {
              token = value;
              updateButtons();
            },
            "expired-callback": () => {
              token = "";
              updateButtons();
            },
            "error-callback": () => {
              token = "";
              updateButtons();
              showMessage(
                "Verification failed. Please reload the page to try again.",
                true,
              );
            },
          },
        );
      })
      .catch((error: Error) => showMessage(error.message, true));
  }

  form.addEventListener("submit", async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy || complete || (sitekey && !token)) return;
    // Capture the clicked approval/denial button before disabling controls.
    const fields = new FormData(form, event.submitter);
    busy = true;
    updateButtons();
    message.hidden = true;
    const value = (key: string) => String(fields.get(key) ?? "");
    // The server renders a validated local continuation, including signed MCP queries.
    const callbackURL = form.dataset.next || "/auth/dashboard";
    const fetchOptions = token
      ? { headers: { "x-captcha-response": token } }
      : {};
    const check = <
      T extends {
        error: { code?: string; message?: string; status?: number } | null;
      },
    >(
      result: T,
    ): T => {
      if (result.error) throw new Error(errorMessage(result.error));
      return result;
    };
    try {
      switch (form.dataset.auth) {
        case "magic-link":
          check(
            await authClient.signIn.magicLink({
              email: value("email"),
              callbackURL,
              fetchOptions,
            }),
          );
          showMessage(`Check ${value("email")} for a sign-in link.`);
          break;
        case "login":
          check(
            await authClient.signIn.email({
              email: value("email"),
              password: value("password"),
              callbackURL,
              fetchOptions,
            }),
          );
          break;
        case "signup":
          check(
            await authClient.signUp.email({
              name: value("name"),
              email: value("email"),
              password: value("password"),
              callbackURL,
              fetchOptions,
            }),
          );
          form.reset();
          showMessage("Check your email to verify your address and sign in.");
          break;
        case "forgot-password":
          check(
            await authClient.requestPasswordReset({
              email: value("email"),
              redirectTo: "/auth/reset-password",
              fetchOptions,
            }),
          );
          showMessage(
            "If an account exists for that email, a password reset link has been sent.",
          );
          break;
        case "reset-password":
          check(
            await authClient.resetPassword({
              token: value("token"),
              newPassword: value("newPassword"),
            }),
          );
          window.location.assign(
            "/auth/login?message=Password+reset.+Please+log+in.",
          );
          break;
        case "google":
          check(
            await authClient.signIn.social({
              provider: "google",
              callbackURL,
              errorCallbackURL: form.dataset.errorCallback,
            }),
          );
          break;
        case "logout":
          check(await authClient.signOut());
          window.location.assign("/auth/login");
          break;
        case "device":
          if (value("decision") === "approve") {
            check(
              await authClient.device.approve({ userCode: value("user_code") }),
            );
            showMessage(
              "Device authorized. You can close this tab and return to the CLI.",
            );
          } else {
            check(
              await authClient.device.deny({ userCode: value("user_code") }),
            );
            showMessage("Device request denied. You can close this tab.");
          }
          complete = true;
          break;
        case "consent": {
          const result = check(
            await authClient.oauth2.consent({
              accept: value("decision") === "allow",
            }),
          );
          if (!result.data?.url)
            throw new Error(
              "Please restart the connection from your MCP client.",
            );
          break;
        }
        case "invitation":
          check(
            await authClient.organization.acceptInvitation({
              invitationId: value("invitation_id"),
            }),
          );
          window.location.assign(
            "/auth/dashboard?message=Invitation+accepted.",
          );
          break;
      }
    } catch (error) {
      showMessage(
        error instanceof Error
          ? error.message
          : "Unable to connect. Please try again.",
        true,
      );
    } finally {
      busy = false;
      if (sitekey) {
        token = "";
        if (widgetId !== undefined) window.turnstile?.reset(widgetId);
      }
      updateButtons();
    }
  });
  updateButtons();
}
