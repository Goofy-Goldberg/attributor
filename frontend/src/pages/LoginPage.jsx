import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";

import { clearResponseCache } from "@/api.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient, clearApiToken } from "@/lib/auth-client.js";
import { authConfig } from "@/lib/auth-config.js";

export default function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const session = authClient.useSession();
  const [mattermostEnabled, setMattermostEnabled] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    authConfig()
      .then((config) => active && setMattermostEnabled(Boolean(config.mattermostEnabled)))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (session.data) {
    return <Navigate replace to="/" />;
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (step === "email") {
        const result = await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: "sign-in" });
        if (result.error) {
          throw new Error(result.error.message || "Could not send a sign-in code.");
        }
        setStep("code");
      } else {
        const result = await authClient.signIn.emailOtp({ email: email.trim(), otp: code.trim() });
        if (result.error) {
          throw new Error(result.error.message || "That code did not work.");
        }
        clearApiToken();
        clearResponseCache();
        navigate("/", { replace: true });
      }
    } catch (failure) {
      setError(failure.message || "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithMattermost() {
    setError("");
    setBusy(true);
    try {
      const result = await authClient.signIn.social({ provider: "mattermost", callbackURL: "/", errorCallbackURL: "/login" });
      if (result.error) {
        throw new Error(result.error.message || "Could not sign in with Mattermost.");
      }
    } catch (failure) {
      setError(failure.message || "Could not sign in with Mattermost.");
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in to IP Intel</CardTitle>
          <CardDescription>
            {step === "email"
              ? mattermostEnabled ? "Use your stratc.org email address or Mattermost account." : "Use your stratc.org email address."
              : `Enter the code we sent to ${email}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {error || params.has("error") ? (
            <Alert variant="destructive">
              <AlertDescription>
                {error || (params.get("error") === "account_not_linked"
                  ? "Sign in with your email code, then connect Mattermost from the account menu."
                  : "Mattermost sign-in did not finish. Try again.")}
              </AlertDescription>
            </Alert>
          ) : null}
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="sign-in-email">Email address</FieldLabel>
                <Input
                  autoComplete="email"
                  disabled={busy || step === "code"}
                  id="sign-in-email"
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  type="email"
                  value={email}
                />
              </Field>
              {step === "code" ? (
                <Field>
                  <FieldLabel htmlFor="sign-in-code">Sign-in code</FieldLabel>
                  <Input
                    autoComplete="one-time-code"
                    autoFocus
                    id="sign-in-code"
                    inputMode="numeric"
                    onChange={(event) => setCode(event.target.value)}
                    required
                    value={code}
                  />
                </Field>
              ) : null}
            </FieldGroup>
            <Button disabled={busy} type="submit">
              {busy ? <Spinner /> : null}
              {step === "email" ? "Email me a code" : "Sign in"}
            </Button>
          </form>
          {step === "code" ? (
            <Button disabled={busy} onClick={() => { setStep("email"); setCode(""); }} variant="ghost">
              Use a different email
            </Button>
          ) : null}
          {mattermostEnabled ? (
            <Button disabled={busy} onClick={signInWithMattermost} variant="outline">
              Continue with Mattermost
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
