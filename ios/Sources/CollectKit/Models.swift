import Foundation

// The Worker's JSON, as web/src/types.ts has it. Times are milliseconds since 1970; the decoder reads snake_case keys.

public struct UploadedFile: Decodable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let size: Int
    public let uploadedAt: Int
}

public struct FileRef: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let size: Int
    public let uploadedAt: Int
    public let sentBackAt: Int?
    public let mime: String?
}

public struct Note: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let author: String
    public let body: String
    public let createdAt: Int
}

public struct Person: Decodable, Equatable, Sendable {
    public let position: Int
    public let role: String
    public let name: String
}

public struct Item: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let label: String
    public let help: String?
    public let required: Bool
    public let status: String
    public let rejectNote: String?
    public let rejectReasons: [String]
    public let unavailableNote: String?
    public let kind: String
    public let example: String?
    public let options: [String]?
    public let answer: JSON?
    public let personPos: Int?
    public let expiryRule: String?
    public let validMonths: Int?
    public let expiresOn: String?
    public let issuedOn: String?
    public let files: [FileRef]

    public var isFile: Bool { kind == "file" }
}

public struct ClientContact: Decodable, Equatable, Sendable {
    public let name: String?
    public let email: String?
    public let phone: String?
    public let address: String?
}

/// What a client sees of their request, from `GET /c/<token>`.
public struct ClientView: Decodable, Equatable, Sendable {
    public let firmName: String
    public let tz: String
    public let title: String
    public let note: String?
    public let deadline: Int
    public let status: String
    public let expiresAt: Int
    public let contact: ClientContact?
    public let notes: [Note]
    public let people: [Person]
    public let items: [Item]
}

/// The reply to an answer or dates call: the items that apply now.
public struct ItemsReply: Decodable, Sendable {
    public let items: [Item]
}

public struct Exchange: Decodable, Sendable {
    public let token: String
    public let expiresAt: Int
}

public struct Me: Decodable, Equatable, Sendable {
    public struct User: Decodable, Equatable, Sendable {
        public let id: String
        public let email: String
        public let name: String?
        public let role: String
    }

    public struct Firm: Decodable, Equatable, Sendable {
        public let id: String
        public let name: String?
        public let tz: String
        public let planStatus: String
        public let trialEndsAt: Int?
        public let currentPeriodEnd: Int?
        public let pastDueSince: Int?
        public let cancelAtPeriodEnd: Bool
        public let subscribed: Bool
        public let planSource: String?
        public let closedAt: Int?
        public let held: Bool
        public let usable: Bool
    }

    public let user: User
    public let firm: Firm
}

public struct RequestRow: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let clientId: String
    public let clientName: String
    public let title: String
    public let deadline: Int
    public let status: String
    public let empty: Int
    public let submitted: Int
    public let approved: Int
    public let rejected: Int
    public let unavailable: Int
    public let waived: Int
    public let unanswered: Int
    public let expiring: Int
}

public struct RequestCounts: Decodable, Equatable, Sendable {
    public let all: Int
    public let toReview: Int
    public let waiting: Int
    public let expiring: Int
    public let overdue: Int
    public let dueSoon: Int
    public let done: Int
}

public struct RequestPage: Decodable, Sendable {
    public let rows: [RequestRow]
    public let next: Int?
    public let counts: RequestCounts?
}

public struct ReviewItem: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let position: Int
    public let label: String
    public let help: String?
    public let required: Bool
    public let status: String
    public let rejectNote: String?
    public let rejectReasons: [String]
    public let unavailableNote: String?
    public let kind: String
    public let options: [String]?
    public let answer: JSON?
    public let answerAt: Int?
    public let hidden: Bool
    public let personPos: Int?
    public let expiresOn: String?
    public let issuedOn: String?
    public let expiryFlag: String?
    public let files: [FileRef]
}

public struct Applicant: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let position: Int
    public let role: String
    public let name: String
}

public struct RequestDetail: Decodable, Equatable, Sendable {
    public let id: String
    public let clientId: String
    public let title: String
    public let note: String?
    public let deadline: Int
    public let status: String
    public let remindersOn: Bool
    public let people: [Applicant]
    public let items: [ReviewItem]
}

public struct Client: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let email: String?
    public let phone: String?
    public let reference: String?
    public let requests: Int?
}

public struct ClientPage: Decodable, Sendable {
    public let rows: [Client]
    public let next: Int?
}

public struct TemplateItem: Decodable, Equatable, Sendable {
    public let label: String
}

public struct Template: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let builtin: Bool
    public let items: [TemplateItem]
}

public struct SignIn: Decodable, Sendable {
    public let ok: Bool
    public let token: String?
    public let step: String?
    public let pending: String?
}

public struct Challenge: Decodable, Sendable {
    public let challenge: String
    public let required: Bool
}

public struct LinkReply: Decodable, Sendable {
    public let url: String?
}

/// The reasons a document can be sent back for, with the words each is shown in.
public struct Reason: Identifiable, Equatable, Sendable {
    public let id: String
    public let text: String
    public var code: String { id }

    init(_ id: String, _ text: String) {
        self.id = id
        self.text = text
    }
}

public enum Reasons {
    public static let files: [Reason] = [
        Reason("blurry", "Blurry or hard to read"),
        Reason("cut_off", "Cut off or part of the page missing"),
        Reason("glare", "Glare or shadow"),
        Reason("dark", "Too dark"),
        Reason("wrong_document", "Wrong document"),
        Reason("wrong_period", "Wrong year or period"),
        Reason("expired", "Expired"),
        Reason("wrong_person", "Wrong person"),
        Reason("pages_missing", "Pages missing"),
        Reason("locked_pdf", "Password-protected PDF"),
        Reason("other", "Other"),
    ]

    public static let questions: [Reason] = files.filter { ["wrong_period", "wrong_person", "other"].contains($0.id) }

    public static func text(_ code: String) -> String {
        files.first { $0.id == code }?.text ?? code
    }

    /// What a client does about a reason.
    public static func fix(_ code: String) -> String {
        switch code {
        case "blurry": return "Hold the phone still and let it focus, then take it again."
        case "cut_off": return "Show the whole page with all four corners."
        case "glare": return "Move away from the light so the page has no glare or shadow."
        case "dark": return "Take it in better light."
        case "wrong_document": return "This is not the document asked for. Send the right one."
        case "wrong_period": return "Send the one for the right year or period."
        case "expired": return "This one has expired. Send a current one."
        case "wrong_person": return "This is for the wrong person. Send the right one."
        case "pages_missing": return "Some pages are missing. Send every page."
        case "locked_pdf": return "Send a copy without a password."
        default: return "See the note."
        }
    }
}
