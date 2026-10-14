//! The port the harness is asked for, and the fact that a wrong guess here costs
//! the ORIGIN and nothing else.

use std::net::TcpListener;

use crate::options::Options;

/// The port the harness listens on when it is given none - the same one a
/// `scripts\run-web.bat` tab opens on, and therefore the same ORIGIN.
///
/// The app does **not** ask for it by default any more, and that is a measured
/// correction: it is the default every `dsh web` on the machine reaches for, so an app
/// instance that preferred it ended up sharing it with the harness the person was
/// already using - the tab the app opened was answered by the OTHER process, whose
/// launch token it did not have. `-Port 3080` is still one flag away for somebody who
/// wants the shared origin on purpose.
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

/// Whether nothing ANSWERS on this loopback port - asked by connecting, not by binding.
///
/// The bind test above answers "may I have this port"; this one answers "is somebody
/// already there", and they are not the same question. Measured on the machine this was
/// written on: an app instance whose harness held `127.0.0.1:3080` while the browser the
/// user was chatting through held it too - one process had bound it, the other answered
/// on it, and the URL the app opened was answered by the WRONG harness, whose launch
/// token it did not have. A connect refuses to be fooled by that: if anything accepts
/// the connection, this port is not "free" whatever a bind says.
pub fn port_is_unanswered(port: u16) -> bool {
    match std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(250),
    ) {
        // Something is listening: this port is somebody's.
        Ok(stream) => {
            drop(stream);
            false
        }
        Err(_) => true,
    }
}

/// The port to ask the harness for: `-Port` when the person named one, else a free port
/// of its own - **never the shared default**.
///
/// The app used to prefer `3080`, and that is how a tab ended up served by a different
/// harness than the one the app started (measured). A port of its own costs nothing
/// here, because the app opens the tab itself with the launch token in it: nobody has
/// to type an address, and nothing has to be remembered per origin. `-Port 3080` is
/// still the way to say "share the usual origin, I mean it".
pub fn choose_port(options: &Options) -> Option<u16> {
    if options.port > 0 {
        return Some(options.port);
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
    fn a_port_something_answers_on_is_not_free_however_a_bind_answers() {
        // The measured case: a harness holding 3080 while another process also answers
        // on it. The connect probe refuses to call that free.
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!port_is_unanswered(port), "a listening port must read as somebody's");
        // ...and a port nothing listens on reads as nobody's.
        drop(listener);
        assert!(port_is_unanswered(port), "nothing is there once the listener is gone");
    }

    #[test]
    fn with_no_flag_the_port_is_one_of_the_apps_own() {
        // The shared default is never chosen on the app's own initiative, whether or not
        // it happens to be free right now: that is the whole point of the change.
        let options = Options::default();
        let chosen = choose_port(&options).expect("no port could be chosen at all");
        assert_ne!(chosen, DEFAULT_PORT, "the shared default was chosen without being asked for");
        assert!(port_is_free(chosen), "the port chosen is one something already holds");
    }

    #[test]
    fn a_free_port_is_one_nothing_holds() {
        let port = free_port().expect("the OS would not hand out a port");
        assert!(port_is_free(port), "the port just handed out reads as held");
    }
}
