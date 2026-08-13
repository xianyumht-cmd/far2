from pathlib import Path

friend_store = Path('web/src/stores/friend.ts')
store = friend_store.read_text(encoding='utf-8')

old = "  const friendLands = ref<Record<string, any[]>>({})\n  const friendLandsLoading = ref<Record<string, boolean>>({})\n"
new = "  const friendLands = ref<Record<string, any[]>>({})\n  const friendLandsLoading = ref<Record<string, boolean>>({})\n  const friendDogProbes = ref<Record<string, any>>({})\n"
assert old in store, 'friend store ref anchor missing'
store = store.replace(old, new, 1)

old = "        const lands = res.data.data.lands || []\n        const summary = res.data.data.summary || null\n        friendLands.value[friendId] = lands\n        syncFriendPlantSummary(friendId, lands, summary)\n"
new = "        const lands = res.data.data.lands || []\n        const summary = res.data.data.summary || null\n        friendLands.value[friendId] = lands\n        friendDogProbes.value[friendId] = res.data.data.dogProbe || null\n        syncFriendPlantSummary(friendId, lands, summary)\n"
assert old in store, 'friend fetch anchor missing'
store = store.replace(old, new, 1)

old = "    friendLands,\n    friendLandsLoading,\n    blacklist,\n"
new = "    friendLands,\n    friendLandsLoading,\n    friendDogProbes,\n    blacklist,\n"
assert old in store, 'friend return anchor missing'
store = store.replace(old, new, 1)
friend_store.write_text(store, encoding='utf-8')

friends_view = Path('web/src/views/Friends.vue')
view = friends_view.read_text(encoding='utf-8')

old = "  friendLands,\n  friendLandsLoading,\n  blacklist,\n"
new = "  friendLands,\n  friendLandsLoading,\n  friendDogProbes,\n  blacklist,\n"
assert old in view, 'Friends destructure anchor missing'
view = view.replace(old, new, 1)

old = '''              <div v-else-if="!friendLands[friend.gid] || friendLands[friend.gid]?.length === 0" class="py-4 text-center text-gray-500">
                无土地数据
              </div>
              <div v-else class="grid grid-cols-2 gap-2 lg:grid-cols-8 md:grid-cols-5 sm:grid-cols-4">
                <LandCard
                  v-for="land in friendLands[friend.gid]"
                  :key="land.id"
                  :land="land"
                />
              </div>
'''
new = '''              <template v-else>
                <div
                  v-if="friendDogProbes[friend.gid]"
                  class="mb-3 border rounded-lg p-3"
                  :class="friendDogProbes[friend.gid]?.present
                    ? 'border-violet-200 bg-violet-50 dark:border-violet-800/60 dark:bg-violet-950/20'
                    : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'"
                >
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="flex items-center gap-2 font-medium text-gray-700 dark:text-gray-200">
                      <div class="i-carbon-data-vis-1" />
                      护主犬协议探针
                    </div>
                    <span
                      class="rounded px-2 py-0.5 text-xs"
                      :class="friendDogProbes[friend.gid]?.present
                        ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
                        : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'"
                    >
                      {{ friendDogProbes[friend.gid]?.present ? 'field 3 已返回' : 'field 3 未返回' }}
                    </span>
                  </div>
                  <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    只读 · 不增加请求 · {{ friendDogProbes[friend.gid]?.byteLength || 0 }} bytes
                    <span v-if="friendDogProbes[friend.gid]?.parseComplete === false"> · 解析未完整</span>
                  </div>
                  <div v-if="friendDogProbes[friend.gid]?.fields?.length" class="mt-2 flex flex-wrap gap-1.5">
                    <span
                      v-for="(field, index) in friendDogProbes[friend.gid].fields"
                      :key="`${friend.gid}-dog-probe-${index}`"
                      class="rounded bg-white px-2 py-1 font-mono text-xs text-gray-600 shadow-sm dark:bg-gray-800 dark:text-gray-300"
                    >
                      f{{ field.field }}/w{{ field.wire }}
                      <template v-if="field.varint !== undefined">={{ field.varint }}</template>
                      <template v-else-if="field.byteLength !== undefined"> · {{ field.byteLength }}B</template>
                    </span>
                  </div>
                  <div v-else class="mt-2 text-xs text-gray-400">
                    暂无可展示的嵌套 wire 字段。
                  </div>
                </div>

                <div v-if="!friendLands[friend.gid] || friendLands[friend.gid]?.length === 0" class="py-4 text-center text-gray-500">
                  无土地数据
                </div>
                <div v-else class="grid grid-cols-2 gap-2 lg:grid-cols-8 md:grid-cols-5 sm:grid-cols-4">
                  <LandCard
                    v-for="land in friendLands[friend.gid]"
                    :key="land.id"
                    :land="land"
                  />
                </div>
              </template>
'''
assert old in view, 'Friends expanded-land anchor missing'
view = view.replace(old, new, 1)
friends_view.write_text(view, encoding='utf-8')
