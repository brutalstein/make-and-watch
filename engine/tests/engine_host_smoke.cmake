if(NOT DEFINED HOST OR HOST STREQUAL "")
  message(FATAL_ERROR "HOST executable path is required")
endif()
if(NOT DEFINED WORK_DIR OR WORK_DIR STREQUAL "")
  message(FATAL_ERROR "WORK_DIR is required")
endif()

file(MAKE_DIRECTORY "${WORK_DIR}")
set(DB "${WORK_DIR}/smoke-project.sqlite3")
set(INPUT "${WORK_DIR}/requests.jsonl")
file(REMOVE "${DB}" "${DB}-wal" "${DB}-shm" "${INPUT}")

file(WRITE "${INPUT}"
  "{\"protocol\":1,\"id\":\"health\",\"method\":\"health\",\"params\":{}}\n"
  "{\"protocol\":1,\"id\":\"apply\",\"method\":\"project.apply\",\"params\":{\"commands\":[{\"type\":\"node.create\",\"node\":{\"id\":\"series.smoke\",\"kind\":\"series\",\"title\":\"Smoke Series\"}}],\"context\":{\"actor\":\"user\",\"source\":\"process-smoke\",\"reason\":\"verify durable native history\"}}}\n"
  "{\"protocol\":1,\"id\":\"snapshot\",\"method\":\"project.snapshot\",\"params\":{}}\n"
  "{\"protocol\":1,\"id\":\"history\",\"method\":\"project.history\",\"params\":{\"limit\":4}}\n"
)

execute_process(
  COMMAND "${HOST}" --db "${DB}"
  INPUT_FILE "${INPUT}"
  OUTPUT_VARIABLE OUTPUT
  ERROR_VARIABLE ERROR_OUTPUT
  RESULT_VARIABLE RESULT
  TIMEOUT 15
)

if(NOT RESULT STREQUAL "0")
  message(FATAL_ERROR "engine host failed (${RESULT}): ${ERROR_OUTPUT}")
endif()

string(REGEX MATCHALL "\"ok\":true" OK_MATCHES "${OUTPUT}")
list(LENGTH OK_MATCHES OK_COUNT)
if(OK_COUNT LESS 4)
  message(FATAL_ERROR "expected four successful RPC responses, got ${OK_COUNT}: ${OUTPUT}")
endif()

if(NOT OUTPUT MATCHES "series\\.smoke")
  message(FATAL_ERROR "snapshot did not contain persisted smoke node: ${OUTPUT}")
endif()
if(NOT OUTPUT MATCHES "process-smoke")
  message(FATAL_ERROR "history did not expose persisted commit source: ${OUTPUT}")
endif()
if(NOT OUTPUT MATCHES "verify durable native history")
  message(FATAL_ERROR "history did not expose persisted commit reason: ${OUTPUT}")
endif()
if(NOT OUTPUT MATCHES "\"actor\":\"user\"")
  message(FATAL_ERROR "history did not preserve commit actor: ${OUTPUT}")
endif()
if(NOT EXISTS "${DB}")
  message(FATAL_ERROR "engine host did not create the SQLite project database")
endif()

file(REMOVE "${INPUT}" "${DB}" "${DB}-wal" "${DB}-shm")
message(STATUS "engine host process-boundary smoke test passed")
