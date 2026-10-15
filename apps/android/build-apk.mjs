// Gera o APK assinado e o põe em apps/web/public/yfitops.apk (o site oferece o
// download em Ajustes e em Enviar). Precisa do Java 21 e do SDK do Android:
//   ANDROID_DEV=C:/Users/<você>/android-dev  (pasta com jdk-21* e sdk/)
// e de android/keystore.properties apontando para a chave (fora do repositório).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dev = process.env.ANDROID_DEV ?? join(homedir(), "android-dev");
const jdk = readdirSync(dev).find((d) => d.startsWith("jdk-21"));
if (!jdk) throw new Error(`Java 21 não encontrado em ${dev}`);
if (!existsSync(join(here, "android", "keystore.properties"))) throw new Error("Falta android/keystore.properties (a chave de assinatura)");

const env = { ...process.env, JAVA_HOME: join(dev, jdk), ANDROID_HOME: join(dev, "sdk") };
env.PATH = `${join(env.JAVA_HOME, "bin")}${process.platform === "win32" ? ";" : ":"}${env.PATH}`;
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });

run("npx", ["cap", "sync", "android"], here);
run(join(here, "android", process.platform === "win32" ? "gradlew.bat" : "gradlew"), ["assembleRelease", "--console=plain"], join(here, "android"));

const apk = join(here, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
const out = join(here, "..", "web", "public", "yfitops.apk");
copyFileSync(apk, out);
console.log(`\nAPK pronto: ${out} (${(statSync(out).size / 1048576).toFixed(1)} MB)`);
