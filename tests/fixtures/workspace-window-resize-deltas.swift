import Foundation

// Compile with the actual helper under RION_RESIZE_DELTA_TEST. No AX, event
// source, native window, input submission, or pacing is part of this fixture.
@main
struct ResizeDeltaFixture {
  struct Case {
    let name: String
    let origin: CGFloat
    let movement: CGFloat
    let rapid: Bool
    let expected: [Int64]
  }

  static func deltas(origin: CGFloat, movement: CGFloat, rapid: Bool) -> [Int64] {
    let fractions = rapid ? [0.25, 0.9, 0.4, 1.0, 0.25, 1.0, 1.0]
      : [1.0 / 6, 2.0 / 6, 3.0 / 6, 4.0 / 6, 5.0 / 6, 1.0]
    var previous = origin
    return fractions.map { fraction in
      let target = origin + movement * CGFloat(fraction)
      let delta = quantizedResizeMouseDelta(from: previous, to: target)
      previous = target
      return delta
    }
  }

  static func require(_ condition: Bool, _ message: String) throws {
    if !condition {
      throw NSError(domain: "ResizeDeltaFixture", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: message])
    }
  }

  static func main() throws {
    let cases: [Case] = [
      Case(name: "ordinary-positive-32", origin: 0, movement: 32, rapid: false,
           expected: [5, 6, 5, 5, 6, 5]),
      Case(name: "ordinary-negative-32", origin: 0, movement: -32, rapid: false,
           expected: [-5, -6, -5, -5, -6, -5]),
      Case(name: "ordinary-positive-48", origin: 0, movement: 48, rapid: false,
           expected: [8, 8, 8, 8, 8, 8]),
      Case(name: "ordinary-negative-48", origin: 0, movement: -48, rapid: false,
           expected: [-8, -8, -8, -8, -8, -8]),
      Case(name: "ordinary-positive-half", origin: 0, movement: 0.5, rapid: false,
           expected: [0, 0, 0, 0, 0, 1]),
      Case(name: "ordinary-negative-half", origin: 0, movement: -0.5, rapid: false,
           expected: [0, 0, 0, 0, 0, -1]),
      Case(name: "ordinary-positive-one-and-half", origin: 0, movement: 1.5, rapid: false,
           expected: [0, 1, 0, 0, 0, 1]),
      Case(name: "ordinary-negative-one-and-half", origin: 0, movement: -1.5, rapid: false,
           expected: [0, -1, 0, 0, 0, -1]),
      Case(name: "ordinary-positive-half-origin", origin: 100.5, movement: 32, rapid: false,
           expected: [5, 5, 6, 5, 5, 6]),
      Case(name: "ordinary-negative-half-origin", origin: -100.5, movement: -32, rapid: false,
           expected: [-5, -5, -6, -5, -5, -6]),
      Case(name: "ordinary-crosses-zero", origin: -0.5, movement: 1, rapid: false,
           expected: [1, 0, 0, 0, 0, 1]),
      Case(name: "ordinary-half-origin-same-integer-endpoint", origin: 100.5, movement: 0.5,
           rapid: false, expected: [0, 0, 0, 0, 0, 0]),
      Case(name: "rapid-positive-32", origin: 0, movement: 32, rapid: true,
           expected: [8, 21, -16, 19, -24, 24, 0]),
      Case(name: "rapid-negative-32", origin: 0, movement: -32, rapid: true,
           expected: [-8, -21, 16, -19, 24, -24, 0]),
      Case(name: "rapid-positive-48", origin: 0, movement: 48, rapid: true,
           expected: [12, 31, -24, 29, -36, 36, 0]),
      Case(name: "rapid-negative-48", origin: 0, movement: -48, rapid: true,
           expected: [-12, -31, 24, -29, 36, -36, 0]),
      Case(name: "rapid-positive-half", origin: 0, movement: 0.5, rapid: true,
           expected: [0, 0, 0, 1, -1, 1, 0]),
      Case(name: "rapid-negative-half", origin: 0, movement: -0.5, rapid: true,
           expected: [0, 0, 0, -1, 1, -1, 0])
    ]
    var passed: [String] = []
    for test in cases {
      let actual = deltas(origin: test.origin, movement: test.movement, rapid: test.rapid)
      try require(actual == test.expected, "\(test.name): expected \(test.expected), got \(actual)")
      passed.append(test.name)
    }

    let x = deltas(origin: 100.5, movement: 32, rapid: false)
    let y = deltas(origin: -200.25, movement: -48, rapid: false)
    try require(x == [5, 5, 6, 5, 5, 6] && y == [-8, -8, -8, -8, -8, -8],
                "two-axis path mixed coordinate histories")
    passed.append("independent-axes")
    let movements: [CGFloat] = [-48, -32, 32, 48]
    for rapid in [false, true] {
      for movement in movements {
        let outward = deltas(origin: 100.5, movement: movement, rapid: rapid)
        let returning = deltas(origin: 100.5 + movement, movement: -movement, rapid: rapid)
        try require(outward.reduce(0, +) + returning.reduce(0, +) == 0,
                    "round-trip rapid=\(rapid) movement=\(movement) accumulated drift")
      }
    }
    passed.append("ordinary-and-rapid-round-trips")
    try require(quantizedResizeMouseDelta(from: -56.5, to: -56.5) == 0,
                "stationary endpoint produced a relative movement")
    passed.append("stationary-endpoint")
    let output: [String: Any] = ["status": "passed", "cpuOnly": true,
                               "cases": passed, "caseCount": passed.count]
    let data = try JSONSerialization.data(withJSONObject: output)
    print(String(decoding: data, as: UTF8.self))
  }
}
