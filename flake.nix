{
    description = "dim-m20-dash: M20 Ctrl, a dimOS Desktop app for the Deep Robotics Lynx M20 — `nix build .#dimosApp` → bin/dimos-app-server (Deno backend + the React page, built into frontend/dist and committed: nothing to build on a robot)";
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    outputs = { self, nixpkgs }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
        in {
            packages = forAll (pkgs:
                let
                    # the server: deno on the backend, the page as built (frontend/dist); ssh from nixpkgs so a robot without one works
                    serverFor = target:
                        let p = nixpkgs.legacyPackages.${target}; in
                        pkgs.writeTextFile {
                            name = "dimos-app-server-${target}";
                            destination = "/bin/dimos-app-server";
                            executable = true;
                            text = ''
                                #!${p.runtimeShell}
                                export PATH="$PATH:${p.openssh}/bin"
                                export DENO_NO_UPDATE_CHECK=1 DENO_NO_PROMPT=1
                                exec ${p.deno}/bin/deno run -A --no-lock --no-config ${./backend}/main.ts --frontend ${./frontend/dist} "$@"
                            '';
                        };
                in rec {
                    dimosApp = serverFor pkgs.stdenv.hostPlatform.system;
                    default = dimosApp;
                    dimosApp-aarch64-linux = serverFor "aarch64-linux";
                    dimosApp-x86_64-linux = serverFor "x86_64-linux";
                });
        };
}
