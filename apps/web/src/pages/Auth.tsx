import { useEffect, useRef, useState, type FormEvent } from "react";
import { Vinyl } from "../components/Cover";
import { Notice, type Tone } from "../components/Notice";
import { ApiError } from "../lib/api";
import {
  emailCodesEnabled,
  forgotPassword,
  login,
  logout,
  refreshAccount,
  resetPassword,
  sessionStore,
  invitedBy,
  signup,
  startSignup,
  type SignupStart,
} from "../lib/session";
import { useStore } from "../lib/observable";
import { navigate } from "../router";

type Mode = "entrar" | "criar" | "esqueci";
type FieldName = "email" | "phone" | "password" | "password2" | "code";

interface Issue {
  field?: FieldName;
  tone: Tone;
  message: string;
}

/** Erro de validação com campo e tom (amarelo = falta algo, vermelho = errado). */
class FormIssue extends Error {
  constructor(
    public issue: Issue,
  ) {
    super(issue.message);
  }
}

const missing = (field: FieldName, message: string) => new FormIssue({ field, tone: "warn", message });
const wrong = (field: FieldName, message: string) => new FormIssue({ field, tone: "error", message });

function checkPassword(password: string, password2: string) {
  if (!password) throw missing("password", "Escolha uma senha");
  if (password.length < 8) throw missing("password", "A senha precisa de pelo menos 8 caracteres");
  if (!password2) throw missing("password2", "Repita a senha para confirmar");
  if (password !== password2) throw wrong("password2", "As senhas não são iguais");
}

function useForm(fn: () => Promise<Issue | void>) {
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<Issue | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Leva o foco ao campo com problema.
  useEffect(() => {
    if (issue?.field) formRef.current?.querySelector<HTMLInputElement>(`[name="${issue.field}"]`)?.focus();
  }, [issue]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setIssue(null);
    try {
      const result = await fn();
      if (result) setIssue(result);
    } catch (err) {
      setIssue(err instanceof FormIssue ? err.issue : { tone: "error", message: (err as Error).message || "Algo deu errado" });
    } finally {
      setBusy(false);
    }
  };
  /** Ao editar o campo marcado, o aviso some. */
  const clear = (field: FieldName) => setIssue((cur) => (cur?.field === field ? null : cur));
  return { busy, issue, setIssue, submit, clear, formRef };
}

function Field({
  name,
  label,
  issue,
  onChange,
  ...input
}: {
  name: FieldName;
  label: string;
  issue: Issue | null;
  onChange: (v: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "name">) {
  const mine = issue?.field === name ? issue : null;
  return (
    <label>
      <span>{label}</span>
      <input
        name={name}
        {...input}
        className={[input.className, mine && `tone-${mine.tone}`].filter(Boolean).join(" ") || undefined}
        aria-invalid={mine ? true : undefined}
        aria-describedby={mine ? `${name}-notice` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {mine && (
        <Notice tone={mine.tone} id={`${name}-notice`}>
          {mine.message}
        </Notice>
      )}
    </label>
  );
}

/** Conta criada, esperando o administrador aceitar. */
export function PendingPage() {
  const session = useStore(sessionStore);
  useEffect(() => {
    // Pergunta de tempos em tempos: quando for aceita, o app abre sozinho.
    const timer = setInterval(() => void refreshAccount(), 15_000);
    const onFocus = () => document.visibilityState === "visible" && void refreshAccount();
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);
  return (
    <Shell>
      <div className="auth-form pending">
        <p>
          Pedido enviado. Assim que for aceito, o app abre sozinho
          {session?.email && (
            <>
              {" "}
              para <strong>{session.email}</strong>
            </>
          )}
          .
        </p>
        <p className="muted small">Pode fechar e voltar depois: você continua conectado.</p>
        <div className="auth-links">
          <button className="link" onClick={() => void refreshAccount()}>
            já fui aceito
          </button>
          <button className="link" onClick={() => void logout()}>
            sair
          </button>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-logo">
        <Vinyl seed="" label="var(--brand)" spinning />
      </div>
      <h1>yfitops</h1>
      {children}
    </main>
  );
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Celular com DDD (10 ou 11 dígitos), ou com +código do país. */
function checkPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (!digits) throw missing("phone", "Falta o celular");
  const ok = phone.trim().startsWith("+") ? digits.length >= 8 && digits.length <= 15 : [10, 11, 12, 13].includes(digits.length);
  if (!ok) throw wrong("phone", "Coloque o DDD e o número, ex.: (11) 98765-4321");
}

/** Formata enquanto digita: (11) 98765-4321. */
export function maskPhone(v: string): string {
  if (v.trim().startsWith("+")) return v.replace(/[^\d+ ()-]/g, "");
  const d = v.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : "";
  const rest = d.slice(2);
  const cut = d.length === 11 ? 5 : 4;
  return `(${d.slice(0, 2)}) ${rest.slice(0, cut)}${rest.length > cut ? `-${rest.slice(cut)}` : ""}`;
}

/** Associa erros do servidor ao campo certo. */
function fromServer(err: unknown, field: FieldName): never {
  if (err instanceof ApiError) {
    if (err.status === 403 || err.status === 409) throw wrong("email", err.message);
    if (err.status === 401) throw wrong("password", err.message);
    if (err.status === 400 && /celular/i.test(err.message)) throw wrong("phone", err.message);
    if (err.status === 400 || err.status === 429) throw wrong(field, err.message);
  }
  throw err;
}

export function AuthPage() {
  // Chegou por um convite: já abre em criar conta.
  const [mode, setMode] = useState<Mode>(() => (invitedBy() ? "criar" : "entrar"));
  /** Criar conta tem duas etapas: dados → código recebido por e-mail. */
  const [step, setStep] = useState<"dados" | "codigo">("dados");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  /** Sem código por e-mail, a senha nova vem por um link que quem cuida do app manda. */
  const [emailLinks, setEmailLinks] = useState(true);
  useEffect(() => {
    void emailCodesEnabled().then(setEmailLinks);
  }, []);

  const { busy, issue, setIssue, submit, clear, formRef } = useForm(async () => {
    if (mode === "criar" && step === "codigo") {
      if (!code.trim()) throw missing("code", "Digite o código que chegou no seu e-mail");
      if (code.replace(/\D/g, "").length !== 6) throw missing("code", "O código tem 6 números");
      await signup(email, password, code, phone).catch((e) => fromServer(e, "code"));
      return;
    }
    if (!email.trim()) throw missing("email", "Falta o e-mail");
    if (!EMAIL_RE.test(email.trim())) throw missing("email", "Esse e-mail parece incompleto");
    if (mode === "entrar") {
      if (!password) throw missing("password", "Falta a senha");
      await login(email, password).catch((e) => fromServer(e, "password"));
    } else if (mode === "criar") {
      checkPhone(phone);
      checkPassword(password, password2);
      const res = await startSignup(email).catch((e) => fromServer(e, "email"));
      // Sem código: a conta já é criada e fica esperando a aprovação.
      if (!res.codeRequired) {
        await signup(email, password, "", phone).catch((e) => fromServer(e, "email"));
        return;
      }
      setStep("codigo");
      return codeSent(res, "Enviamos um código para");
    } else {
      await forgotPassword(email);
      setSent(true);
      return {
        tone: "ok",
        message: emailLinks
          ? "Se existir uma conta com esse e-mail, o link chega em instantes. Ele vale por 1 hora."
          : "Peça a quem cuida do app um link para criar uma senha nova. Ele chega por mensagem e vale por 1 hora.",
      };
    }
  });

  /** Sem e-mail configurado (desenvolvimento), mostra e já preenche o código. */
  const codeSent = (res: SignupStart, prefix: string): Issue => {
    if (!res.mailed && res.devCode) {
      setCode(res.devCode);
      return { tone: "warn", message: `Modo de teste: o e-mail não foi enviado. Seu código é ${res.devCode}` };
    }
    setCode("");
    return { tone: "ok", message: `${prefix} ${res.sentTo ?? email.trim()}` };
  };

  const switchTo = (m: Mode) => {
    setMode(m);
    setStep("dados");
    setSent(false);
    setIssue(null);
  };

  const resend = async () => {
    try {
      setIssue(codeSent(await startSignup(email), "Mandamos um novo código para"));
    } catch (e) {
      setIssue({ field: "code", tone: e instanceof ApiError && e.status === 429 ? "warn" : "error", message: (e as Error).message });
    }
  };

  const general = issue && !issue.field ? issue : null;
  const codeStep = mode === "criar" && step === "codigo";

  return (
    <Shell>
      <form ref={formRef} className="form auth-form" onSubmit={submit} noValidate>
        {mode === "criar" && invitedBy() && (
          <p className="muted small invite-note">Você recebeu um convite. Crie sua conta: o acesso é liberado assim que ela for aprovada.</p>
        )}
        {codeStep ? (
          <>
            {general && <Notice tone={general.tone}>{general.message}</Notice>}
            <Field
              name="code"
              label="Código de 6 números"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              className="code-input"
              value={code}
              issue={issue}
              onChange={(v) => (setCode(v.replace(/[^\d ]/g, "")), clear("code"))}
            />
          </>
        ) : (
          <>
            <Field
              name="email"
              label="E-mail"
              type="email"
              autoComplete="email"
              value={email}
              issue={issue}
              onChange={(v) => (setEmail(v), clear("email"))}
            />
            {mode === "criar" && (
              <Field
                name="phone"
                label="Celular (WhatsApp)"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="(11) 98765-4321"
                value={phone}
                issue={issue}
                onChange={(v) => (setPhone(maskPhone(v)), clear("phone"))}
              />
            )}
            {mode !== "esqueci" && (
              <Field
                name="password"
                label="Senha"
                type="password"
                autoComplete={mode === "criar" ? "new-password" : "current-password"}
                value={password}
                issue={issue}
                onChange={(v) => (setPassword(v), clear("password"))}
              />
            )}
            {mode === "criar" && (
              <Field
                name="password2"
                label="Repita a senha"
                type="password"
                autoComplete="new-password"
                value={password2}
                issue={issue}
                onChange={(v) => (setPassword2(v), clear("password2"))}
              />
            )}
            {general && <Notice tone={general.tone}>{general.message}</Notice>}
          </>
        )}
        {!(mode === "esqueci" && sent) && (
          <button className="primary" disabled={busy}>
            {busy
              ? "aguarde…"
              : mode === "entrar"
                ? "Entrar"
                : mode === "esqueci"
                  ? emailLinks
                    ? "Enviar link"
                    : "Ok"
                  : codeStep
                    ? "Criar conta"
                    : "Continuar"}
          </button>
        )}
      </form>
      <nav className="auth-links">
        {codeStep ? (
          <>
            <button onClick={resend}>Reenviar código</button>
            <button onClick={() => (setStep("dados"), setIssue(null))}>Trocar e-mail</button>
          </>
        ) : (
          <>
            {mode !== "entrar" && <button onClick={() => switchTo("entrar")}>Já tenho conta</button>}
            {mode !== "criar" && <button onClick={() => switchTo("criar")}>Criar conta</button>}
            {mode !== "esqueci" && <button onClick={() => switchTo("esqueci")}>Esqueci a senha</button>}
          </>
        )}
      </nav>
    </Shell>
  );
}

export function ResetPage({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const { busy, issue, submit, clear, formRef } = useForm(async () => {
    checkPassword(password, password2);
    await resetPassword(token, password);
    navigate("/");
  });
  const general = issue && !issue.field ? issue : null;
  return (
    <Shell>
      <form ref={formRef} className="form auth-form" onSubmit={submit} noValidate>
        <p className="muted">Escolha uma nova senha. Suas músicas continuam todas lá.</p>
        <Field
          name="password"
          label="Nova senha"
          type="password"
          autoComplete="new-password"
          value={password}
          issue={issue}
          onChange={(v) => (setPassword(v), clear("password"))}
        />
        <Field
          name="password2"
          label="Repita a senha"
          type="password"
          autoComplete="new-password"
          value={password2}
          issue={issue}
          onChange={(v) => (setPassword2(v), clear("password2"))}
        />
        {general && <Notice tone={general.tone}>{general.message}</Notice>}
        <button className="primary" disabled={busy}>
          {busy ? "aguarde…" : "Salvar nova senha"}
        </button>
      </form>
      <nav className="auth-links">
        <button onClick={() => navigate("/")}>Voltar</button>
      </nav>
    </Shell>
  );
}
