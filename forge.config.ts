import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerFlatpak } from "@electron-forge/maker-flatpak";
import { MakerFlatpakOptionsConfig } from "@electron-forge/maker-flatpak/dist/Config";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { PublisherGithub } from "@electron-forge/publisher-github";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import fs from "node:fs";
import path from "node:path";

// import { globSync } from "node:fs";

const STRINGS = {
  author: "PoBruno",
  name: "Stoat",
  execName: "stoat",
  description: "Stoat desktop client.",
};

const ASSET_DIR = "assets/desktop";

/**
 * Build targets for the desktop app
 *
 * Cada maker declara as plataformas que suporta, entao o Forge ja filtra
 * pelo host: Deb/Flatpak so rodam no Linux.
 *
 * O instalador do Windows NAO sai daqui. O MakerSquirrel, que era o alvo
 * padrao, gera um setup que instala em silencio no %LocalAppData% e abre o
 * app: sem assistente, sem escolher pasta, sem atalho no Menu Iniciar. Quem
 * baixava achava que tinha apenas executado o programa.
 *
 * O Squirrel existe para dar atualizacao automatica, e este fork a desativa
 * de proposito (ver o comentario em src/main.ts), entao ele so entregava a
 * pior experiencia de instalacao sem nenhuma contrapartida.
 *
 * No lugar dele, o hook `postMake` chama o electron-builder para gerar um
 * instalador NSIS a partir da pasta que o Forge acabou de empacotar.
 */
const makers: ForgeConfig["makers"] = [
  new MakerZIP({}),
  new MakerDeb({
    options: {
      productName: STRINGS.name,
      // `description` alem de `productDescription`: o
      // electron-installer-debian recusa o pacote sem ela, e o package.json
      // nao tinha esse campo. Sem isto o build de Linux morre no final,
      // depois de empacotar tudo.
      description: STRINGS.description,
      productDescription: STRINGS.description,
      // O instalador procura o binario pelo `name` do package.json
      // ("stoat-desktop"), mas o packager gera "stoat" via executableName.
      // Sem apontar aqui ele nao acha o executavel.
      bin: STRINGS.execName,
      categories: ["Network"],
      icon: `${ASSET_DIR}/icon.png`,
    },
  }),
];

// Flatpak exige `flatpak-builder` + runtimes (~GBs) instalados na maquina.
// Fora do caminho padrao; habilite com ENABLE_FLATPAK=1.
if (process.env.ENABLE_FLATPAK) {
  makers.push(
    new MakerFlatpak({
      options: {
        id: "chat.stoat.StoatDesktop",
        description: STRINGS.description,
        productName: STRINGS.name,
        productDescription: STRINGS.description,
        runtimeVersion: "25.08",
        icon: {
          "16x16": `${ASSET_DIR}/hicolor/16x16.png`,
          "32x32": `${ASSET_DIR}/hicolor/32x32.png`,
          "64x64": `${ASSET_DIR}/hicolor/64x64.png`,
          "128x128": `${ASSET_DIR}/hicolor/128x128.png`,
          "256x256": `${ASSET_DIR}/hicolor/256x256.png`,
          "512x512": `${ASSET_DIR}/hicolor/512x512.png`,
        } as unknown,
        categories: ["Network"],
        modules: [
          // use the latest zypak -- Electron sandboxing for Flatpak
          {
            name: "zypak",
            sources: [
            {
              type: "git",
              url: "https://github.com/refi64/zypak",
              tag: "v2025.09",
            },
          ],
        },
      ],
      finishArgs: [
        // default arguments found by running
        // DEBUG=electron-installer-flatpak* pnpm make
        "--socket=fallback-x11",
        "--socket=wayland",
        "--share=ipc",
        "--share=network",
        "--device=dri",
        "--device=all",
        "--socket=pulseaudio",
        "--filesystem=xdg-run/pipewire-0",
        "--filesystem=xdg-videos:ro",
        "--filesystem=xdg-pictures:ro",
        "--filesystem=xdg-download",
        "--filesystem=xdg-run/speech-dispatcher",
        "--talk-name=org.freedesktop.ScreenSaver",
        "--talk-name=org.freedesktop.Notifications",
        "--talk-name=org.kde.StatusNotifierWatcher",
        "--talk-name=com.canonical.AppMenu.Registrar",
        "--talk-name=com.canonical.indicator.application",
        "--talk-name=com.canonical.Unity",
        "--env=XCURSOR_PATH=/run/host/user-share/icons:/run/host/share/icons",
        "--env=ELECTRON_TRASH=gio",
        "--env=TMPDIR=xdg-run/app/chat.stoat.StoatDesktop",
      ],
        files: [],
      } as MakerFlatpakOptionsConfig,
    }),
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: STRINGS.name,
    executableName: STRINGS.execName,
    icon:
      process.platform === "darwin"
        ? `${ASSET_DIR}/icon.icon`
        : `${ASSET_DIR}/icon`,
    // extraResource: [
    //   // include all the asset files
    //   ...globSync(ASSET_DIR + "/**/*"),
    // ],
  },
  rebuildConfig: {},
  makers,
  hooks: {
    // Copy the node-pipewire dist to the app on linux
    packageAfterCopy: async (_config, buildPath, _version, platform) => {
      if (platform === "linux") {
        // Copy only the files we need to run the code, which is dist, LICENSE, and package.json
        fs.cpSync(
          "node_modules/node-pipewire/dist",
          path.join(buildPath, "node_modules/node-pipewire/dist"),
          { recursive: true },
        );
        fs.cpSync(
          "node_modules/node-pipewire/LICENSE",
          path.join(buildPath, "node_modules/node-pipewire/LICENSE"),
          { recursive: true },
        );
        fs.cpSync(
          "node_modules/node-pipewire/package.json",
          path.join(buildPath, "node_modules/node-pipewire/package.json"),
          { recursive: true },
        );
      }
    },
    /**
     * Gera o instalador do Windows depois que o Forge empacota.
     *
     * Fica num hook, e nao num maker, porque o electron-builder nao e um
     * maker do Forge. Assim `pnpm make` continua sendo o unico comando
     * necessario, em vez de exigir um segundo passo que alguem esqueceria.
     *
     * `--prepackaged` reaproveita a pasta que o Forge acabou de produzir:
     * o electron-builder so monta o instalador, sem reempacotar o app.
     */
    postMake: async (_config, results) => {
      if (process.platform !== "win32") return results;

      const empacotado = path.resolve("out", `${STRINGS.name}-win32-x64`);
      if (!fs.existsSync(empacotado)) {
        console.warn(`[nsis] pasta empacotada nao encontrada: ${empacotado}`);
        return results;
      }

      const { execFileSync } = await import("node:child_process");

      // Chama o cli.js direto com o proprio node, em vez de `npx`. No Windows
      // o Node recusa executar arquivos .cmd desde a correcao do
      // CVE-2024-27980, e `npx.cmd` falha com um EINVAL que nao explica nada.
      const cli = require.resolve("electron-builder/cli.js");

      console.log("[nsis] gerando o instalador do Windows");
      execFileSync(
        process.execPath,
        [cli, "--prepackaged", empacotado, "--win", "nsis"],
        { stdio: "inherit" },
      );

      const instalador = path.resolve(
        "out/make/nsis",
        `${STRINGS.execName}-setup.exe`,
      );
      if (fs.existsSync(instalador)) {
        results.push({
          artifacts: [instalador],
          packageJSON: JSON.parse(fs.readFileSync("package.json", "utf-8")),
          platform: "win32",
          arch: "x64",
        });
      }

      return results;
    },
  },
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          // Preload da janela de sobreposicao de anotacao (laser).
          //
          // Ele nao e so um preload: monta o proprio DOM e desenha. Entrou
          // como preload porque `renderer` esta vazio -- o app carrega uma
          // URL remota, entao nao existe pipeline de renderer local, e criar
          // um so para uma pagina de canvas traria globais de dev server e
          // copia de assets para dentro do asar. Ver src/anotacao-preload.ts.
          entry: "src/anotacao-preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  publishers: [
    new PublisherGithub({
      repository: {
        owner: "stoatchat",
        name: "for-desktop",
      },
    }),
  ],
};

export default config;
