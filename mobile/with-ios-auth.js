const fs = require("node:fs/promises");
const path = require("node:path");
const { IOSConfig, withDangerousMod } = require("expo/config-plugins");

// Firebase 26 uses the CocoaPods SDK compatible with Google Sign-In, but predates Expo's scene template.
module.exports = config => withDangerousMod(config, ["ios", async mod => {
  const delegate = IOSConfig.Paths.getAppDelegate(mod.modRequest.projectRoot);
  const startup = "    let delegate = ReactNativeDelegate()";
  if (!delegate.contents.includes("FirebaseApp.configure()")) {
    if (!delegate.contents.includes(startup)) throw new Error("Cannot initialize Firebase in the generated AppDelegate.");
    const imports = delegate.contents.includes("import FirebaseCore") ? "" : "import FirebaseCore\n";
    await fs.writeFile(delegate.path, imports + delegate.contents.replace(startup, "    FirebaseApp.configure()\n" + startup));
  }

  const scenePath = path.join(path.dirname(delegate.path), "SceneDelegate.swift");
  const scene = await fs.readFile(scenePath, "utf8");
  const anchor = "  // Extension point for config plugins.";
  if (!scene.includes("GIDSignIn.sharedInstance.handle")) {
    if (!scene.includes(anchor)) throw new Error("Cannot add auth callbacks to the generated SceneDelegate.");
    await fs.writeFile(scenePath, "import UIKit\nimport FirebaseAuth\nimport GoogleSignIn\n" + scene.replace(anchor, `  override func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    let remaining = contexts.filter {
      !Auth.auth().canHandle($0.url) && !GIDSignIn.sharedInstance.handle($0.url)
    }
    if !remaining.isEmpty {
      super.scene(scene, openURLContexts: remaining)
    }
  }`));
  }
  return mod;
}]);
