using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "test", worker = (
      compatibilityDate = "2026-01-01",
      globalOutbound = "fixture",
      modules = [
        (name = "test.js", esModule = embed "test.js"),
        (name = "app.js", esModule = embed "../../dist/server/index.js")
      ]
    )),
    (name = "fixture", worker = (
      compatibilityDate = "2026-01-01",
      modules = [(name = "fixture.js", esModule = embed "fixture.js")]
    )),
    (name = "internet", network = (allow = []))
  ]
);
