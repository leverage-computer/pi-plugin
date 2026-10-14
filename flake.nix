{
  description = "The Leverage plugin for Pi: its development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    # Only for Bun: stable has 1.3.13, and the project pins 1.4.2.
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    git-hooks.url = "github:cachix/git-hooks.nix";
    git-hooks.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      nixpkgs,
      nixpkgs-unstable,
      git-hooks,
      ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forEach = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
      # Lints each commit once the shell is entered.
      hooks = forEach (
        system: pkgs:
        git-hooks.lib.${system}.run {
          src = ./.;
          hooks = {
            # The project's own Biome, the version CI checks with.
            biome = {
              enable = true;
              name = "biome";
              entry = "node_modules/.bin/biome check --write --no-errors-on-unmatched --files-ignore-unknown=true";
              types_or = [
                "javascript"
                "jsx"
                "ts"
                "tsx"
                "json"
              ];
            };
            nixfmt.enable = true;
          };
        }
      );
    in
    {
      devShells = forEach (
        system: pkgs: {
          default = pkgs.mkShell {
            inherit (hooks.${system}) shellHook;
            packages = [
              nixpkgs-unstable.legacyPackages.${system}.bun
              pkgs.nodejs_24
              # The tests drive real terminals through Python.
              pkgs.python3
              # Zed's language server for flake.nix.
              pkgs.nil
            ]
            ++ hooks.${system}.enabledPackages;
          };
        }
      );
    };
}
