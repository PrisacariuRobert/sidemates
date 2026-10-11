// Sidemates' bridge to Apple's on-device model (Apple Intelligence).
// Free, private and offline: nothing leaves the Mac. Reads one JSON request
// on stdin and writes one JSON answer on stdout.
//   {"mode":"status"}                              -> {"available":true} | {"available":false,"reason":"..."}
//   {"mode":"respond","instructions":"...","prompt":"..."} -> {"text":"..."} | {"error":"...","code":"..."}
import Foundation
import FoundationModels

struct Request: Decodable {
  let mode: String
  let instructions: String?
  let prompt: String?
}

func reply(_ object: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{\"error\":\"Could not write the answer.\",\"code\":\"internal\"}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}

func unavailableReason(_ reason: SystemLanguageModel.Availability.UnavailableReason) -> String {
  switch reason {
  case .deviceNotEligible: return "This Mac can't run Apple Intelligence."
  case .appleIntelligenceNotEnabled: return "Apple Intelligence is turned off. Turn it on in System Settings → Apple Intelligence & Siri."
  case .modelNotReady: return "Apple Intelligence is still getting ready on this Mac. Try again in a little while."
  @unknown default: return "Apple Intelligence isn't available on this Mac."
  }
}

@main struct AppleAI {
  static func main() async {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let request = try? JSONDecoder().decode(Request.self, from: input) else {
      reply(["error": "The request couldn't be read.", "code": "bad_request"])
    }
    let model = SystemLanguageModel.default
    if case .unavailable(let reason) = model.availability {
      if request.mode == "status" { reply(["available": false, "reason": unavailableReason(reason)]) }
      reply(["error": unavailableReason(reason), "code": "unavailable"])
    }
    if request.mode == "status" { reply(["available": true]) }
    guard request.mode == "respond", let prompt = request.prompt, !prompt.isEmpty else {
      reply(["error": "Nothing to answer.", "code": "bad_request"])
    }
    do {
      let session = LanguageModelSession(instructions: request.instructions ?? "")
      let response = try await session.respond(to: prompt)
      reply(["text": response.content])
    } catch let error as LanguageModelSession.GenerationError {
      switch error {
      case .exceededContextWindowSize: reply(["error": "This is too long for Apple's built-in AI.", "code": "too_long"])
      case .guardrailViolation: reply(["error": "Apple's built-in AI declined this request.", "code": "declined"])
      case .rateLimited: reply(["error": "Apple's built-in AI is busy. Try again in a moment.", "code": "busy"])
      default: reply(["error": "Apple's built-in AI couldn't answer this.", "code": "failed"])
      }
    } catch {
      reply(["error": "Apple's built-in AI couldn't answer this.", "code": "failed"])
    }
  }
}
