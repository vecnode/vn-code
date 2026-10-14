//! The port the harness is asked for, and the fact that a wrong guess here costs
//! the ORIGIN and nothing else.

use std::net::TcpListener;

use crate::options::Options;

/// The port the harness listens on when it is given none - the same one a
/// `scripts\run-web.bat` tab opens on, and therefore the same ORIGIN.
///
/// The shell prefers it so the little state the client keeps per origin survives
/// a run, the way it does in Chrome. It is only a preference and can never change
/// what the window shows: the URL loaded is the one the harness prints, so a port
/// that is already held - by `run-web`, by the Web GUI, by anything - falls
/// through to a free one.
pub const DEFAULT_PORT: u16 = 3080;

/// A free loopback port.
///
/// Binding port 0 lets the operating system choose; the port is then released for
/// the harness to take. There is a hair of a race between the release and the
/// harness binding it, which is why `-Port` exists as the way out of it.
pub fn free_port() -> Option<u16> {
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|address| address.port())
}

/// Whether nothing holds this loopback port right now.
///
/// The listener is closed again immediately, which leaves the same hair of a race
/// [`free_port`] has - and the same escape hatch. It is also the assertion Stop
/// makes after it kills the tree: docs/PLAN-egui-shell.md's M1 exit criterion is
/// that the port is free again, and this is how that is measured rather than
/// assumed.
pub fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// The port to ask the harness for: `-Port`, else the harness's own default when
/// it is free, else any free one.
pub fn choose_port(options: &Options) -> Option<u16> {
    if options.port > 0 {
        return Some(options.port);
    }
    if port_is_free(DEFAULT_PORT) {
        return Some(DEFAULT_PORT);
    }
    free_port()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_port_always_wins() {
        // 3099 rather than the default, and no network is touched for it.
        let options = Options { port: 3099, ..Options::default() };
        assert_eq!(choose_port(&options), Some(3099));
    }

    #[test]
    fn with_no_flag_the_harness_own_default_comes_first() {
        // Only true while nothing holds it; when the machine's own harness is
        // running, the answer is a different free port and this assertion would be
        // wrong - so it is stated as the rule, not as the number.
        let options = Options::default();
        let chosen = choose_port(&options);
        assert!(chosen.is_some(), "no port could be chosen at all");
        if port_is_free(DEFAULT_PORT) {
            assert_eq!(chosen, Some(DEFAULT_PORT));
        } else {
            assert_ne!(chosen, Some(DEFAULT_PORT), "a held port was chosen anyway");
        }
    }

    #[test]
    fn a_free_port_is_one_nothing_holds() {
        let port = free_port().expect("the OS would not hand out a port");
        assert!(port_is_free(port), "the port just handed out reads as held");
    }
}
