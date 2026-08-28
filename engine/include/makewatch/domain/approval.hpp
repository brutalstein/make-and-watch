#pragma once

namespace makewatch::domain {

enum class ApprovalState {
  kDraft,
  kReview,
  kApproved,
  kLocked,
  kInvalidated,
  kFailed,
};

[[nodiscard]] constexpr bool is_mutable(ApprovalState state) noexcept {
  return state != ApprovalState::kLocked;
}

[[nodiscard]] constexpr bool allows_final_synthesis(ApprovalState state) noexcept {
  return state == ApprovalState::kApproved || state == ApprovalState::kLocked;
}

}  // namespace makewatch::domain
