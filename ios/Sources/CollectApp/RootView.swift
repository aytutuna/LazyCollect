#if os(iOS)
import CollectKit
import SwiftUI

/// The view the app target starts.
public struct CollectRoot: View {
    @StateObject private var app = AppModel()

    public init() {}

    public var body: some View {
        Group {
            if let token = app.saved.staff {
                ProRootView(token: token)
            } else {
                LinksStack()
            }
        }
        .environmentObject(app)
        .onOpenURL { url in
            Task { await app.open(link: url.absoluteString) }
        }
        .alert("Lazy Collect", isPresented: Binding(get: { app.notice != nil }, set: { if !$0 { app.notice = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(app.notice ?? "")
        }
        .overlay { if app.busy { ProgressView().controlSize(.large) } }
    }
}

/// The requests a person was sent links to, and the way to sign in as a professional.
struct LinksStack: View {
    @EnvironmentObject var app: AppModel

    var body: some View {
        NavigationStack(path: $app.path) {
            HomeView()
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .client(let token): ClientRequestView(token: token)
                    case .signIn: SignInView()
                    }
                }
        }
    }
}

struct HomeView: View {
    @EnvironmentObject var app: AppModel
    @State private var pasted = ""

    var body: some View {
        List {
            if !app.saved.clients.isEmpty {
                Section("Requests for you") {
                    ForEach(app.saved.clients) { session in
                        NavigationLink(value: Route.client(session.token)) {
                            VStack(alignment: .leading) {
                                Text(session.title)
                                Text(session.firm).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .onDelete { offsets in
                        let tokens = offsets.map { app.saved.clients[$0].token }
                        Task { for token in tokens { await app.remove(client: token) } }
                    }
                }
            }
            Section {
                TextField("Paste the link from your email", text: $pasted)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("link-field")
                Button("Open the link") {
                    let text = pasted
                    pasted = ""
                    Task { await app.open(link: text) }
                }
                .disabled(pasted.isEmpty)
            } header: {
                Text("Got a link from your accountant or consultant?")
            } footer: {
                Text("Links in the email open here by themselves once the app is installed.")
            }
            if app.saved.staff == nil {
                Section {
                    Button("Sign in as a professional") { app.path.append(.signIn) }
                } footer: {
                    Text("For accountants, immigration consultants and anyone who collects documents.")
                }
            }
        }
        .navigationTitle("Lazy Collect")
    }
}
#endif
