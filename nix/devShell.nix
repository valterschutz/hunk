{pkgs}:
pkgs.mkShell {
  buildInputs = with pkgs; [
    bun
    git
    # Bundled VCS providers run their real binaries in the unit suite.
    jujutsu
    nodejs
  ];
}
