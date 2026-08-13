const protobuf = require('protobufjs');

const BRIEF_DOG_FIELD_NO = 3;
const MAX_SUMMARY_FIELDS = 32;

function toDecimalString(value) {
    if (value === undefined || value === null) return '0';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value.toString === 'function') return value.toString();
    return String(value);
}

function scanWireFields(input, maxFields = MAX_SUMMARY_FIELDS) {
    const buffer = Buffer.from(input || []);
    const reader = protobuf.Reader.create(buffer);
    const fields = [];
    let complete = true;

    try {
        while (reader.pos < reader.len) {
            if (fields.length >= maxFields) {
                complete = false;
                break;
            }

            const tag = reader.uint32();
            const field = tag >>> 3;
            const wire = tag & 7;
            if (field <= 0) {
                complete = false;
                break;
            }

            if (wire === 0) {
                fields.push({ field, wire, varint: toDecimalString(reader.uint64()) });
                continue;
            }
            if (wire === 2) {
                const bytes = Buffer.from(reader.bytes());
                fields.push({ field, wire, byteLength: bytes.length, bytes });
                continue;
            }
            if (wire === 1) {
                if (reader.pos + 8 > reader.len) {
                    complete = false;
                    break;
                }
                reader.pos += 8;
                fields.push({ field, wire, byteLength: 8 });
                continue;
            }
            if (wire === 5) {
                if (reader.pos + 4 > reader.len) {
                    complete = false;
                    break;
                }
                reader.pos += 4;
                fields.push({ field, wire, byteLength: 4 });
                continue;
            }

            complete = false;
            break;
        }
    } catch {
        complete = false;
    }

    return { fields, complete, byteLength: buffer.length };
}

function sanitizeWireField(field) {
    const result = {
        field: Number(field && field.field) || 0,
        wire: Number(field && field.wire) || 0,
    };
    if (field && Object.prototype.hasOwnProperty.call(field, 'varint')) {
        result.varint = String(field.varint);
    }
    if (field && Object.prototype.hasOwnProperty.call(field, 'byteLength')) {
        result.byteLength = Math.max(0, Number(field.byteLength) || 0);
    }
    return result;
}

function buildFriendDogProbe(rawVisitEnterBody) {
    const outer = scanWireFields(rawVisitEnterBody);
    const dogField = outer.fields.find(field => field.field === BRIEF_DOG_FIELD_NO && field.wire === 2 && field.bytes);
    if (!dogField) {
        return {
            present: false,
            fieldNo: BRIEF_DOG_FIELD_NO,
            byteLength: 0,
            fields: [],
            parseComplete: outer.complete,
            readOnly: true,
        };
    }

    const nested = scanWireFields(dogField.bytes);
    return {
        present: true,
        fieldNo: BRIEF_DOG_FIELD_NO,
        byteLength: dogField.bytes.length,
        fields: nested.fields.map(sanitizeWireField),
        parseComplete: nested.complete,
        readOnly: true,
    };
}

module.exports = {
    BRIEF_DOG_FIELD_NO,
    scanWireFields,
    buildFriendDogProbe,
};
