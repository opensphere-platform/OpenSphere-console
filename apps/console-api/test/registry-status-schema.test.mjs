import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {initialRegistryState,publicRegistryState} from '../src/registry-lifecycle-contract.mjs';
test('registry status response satisfies a closed schema that rejects secret fields',()=>{
 const schema=JSON.parse(readFileSync(new URL('../../../packages/contracts/schemas/registry-credential-status.schema.json',import.meta.url)));
 const ajv=new Ajv({strict:false});addFormats(ajv);const validate=ajv.compile(schema);
 const response=publicRegistryState(initialRegistryState(null,[]));assert.equal(validate(response),true,JSON.stringify(validate.errors));
 assert.equal(validate({...response,refreshToken:'must-never-be-returned'}),false);
 assert.equal(validate({...response,deviceCode:'must-never-be-returned'}),false);
});